package http

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ovra/internal/config"
	"ovra/internal/domain"
	"ovra/internal/storage"
)

func digestServer(t *testing.T, repo *fakeRepo) http.Handler {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewServer(&config.Config{}, repo, nil, nil, nil, nil, log).Routes()
}

func getDigest(t *testing.T, h http.Handler, tenant string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", "/v1/workspaces/"+tenant+"/digest", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// --- GET /v1/workspaces/{tenant}/digest ---

func TestGetDigestEmpty(t *testing.T) {
	repo := newFakeRepo("ws-1")
	repo.workspaces["ws-1"] = domain.Workspace{
		ID: "ws-1", DigestEnabled: true, DigestTime: "09:00",
	}
	h := digestServer(t, repo)

	rec := getDigest(t, h, "ws-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var resp digestResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.DigestEnabled || resp.DigestTime != "09:00" {
		t.Fatalf("digest settings: enabled=%v time=%q", resp.DigestEnabled, resp.DigestTime)
	}
	if len(resp.Assignees) != 0 || len(resp.Unassigned) != 0 {
		t.Fatalf("expected empty digest, got assignees=%d unassigned=%d",
			len(resp.Assignees), len(resp.Unassigned))
	}
}

func TestGetDigestGroupedByAssignee(t *testing.T) {
	repo := newFakeRepo("ws-1")
	repo.workspaces["ws-1"] = domain.Workspace{ID: "ws-1", DigestEnabled: true, DigestTime: "09:00"}

	uid := "user-1"
	repo.users = []domain.User{
		{ID: uid, TenantID: "ws-1", FullName: "Иван Иванов", TgUsername: "@ivan"},
	}
	repo.digestTasks = []domain.Task{
		{
			ID: "t1", TenantID: "ws-1", Title: "Задача Ивана",
			Status: domain.StatusTodo, AssigneeUserID: &uid,
		},
		{
			ID: "t2", TenantID: "ws-1", Title: "Без исполнителя",
			Status: domain.StatusInProgress,
		},
	}
	h := digestServer(t, repo)

	rec := getDigest(t, h, "ws-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp digestResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if len(resp.Assignees) != 1 {
		t.Fatalf("assignees = %d, want 1", len(resp.Assignees))
	}
	if resp.Assignees[0].FullName != "Иван Иванов" || resp.Assignees[0].TgUsername != "@ivan" {
		t.Fatalf("assignee = %+v", resp.Assignees[0])
	}
	if len(resp.Assignees[0].Tasks) != 1 || resp.Assignees[0].Tasks[0].ID != "t1" {
		t.Fatalf("assignee tasks = %+v", resp.Assignees[0].Tasks)
	}

	if len(resp.Unassigned) != 1 || resp.Unassigned[0].ID != "t2" {
		t.Fatalf("unassigned = %+v", resp.Unassigned)
	}
}

func TestGetDigestOverdueFlag(t *testing.T) {
	repo := newFakeRepo("ws-1")
	repo.workspaces["ws-1"] = domain.Workspace{ID: "ws-1"}

	past := time.Now().Add(-24 * time.Hour)
	future := time.Now().Add(24 * time.Hour)
	repo.digestTasks = []domain.Task{
		{ID: "overdue", TenantID: "ws-1", Title: "Просрочена", Deadline: &past},
		{ID: "upcoming", TenantID: "ws-1", Title: "В срок", Deadline: &future},
		{ID: "nodeadline", TenantID: "ws-1", Title: "Без дедлайна"},
	}
	h := digestServer(t, repo)

	rec := getDigest(t, h, "ws-1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var resp digestResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	byID := make(map[string]digestTaskItem)
	for _, item := range resp.Unassigned {
		byID[item.ID] = item
	}

	if !byID["overdue"].Overdue {
		t.Fatal("overdue task must have overdue=true")
	}
	if byID["upcoming"].Overdue {
		t.Fatal("upcoming task must have overdue=false")
	}
	if byID["nodeadline"].Overdue {
		t.Fatal("task without deadline must have overdue=false")
	}
	if byID["overdue"].Deadline == nil {
		t.Fatal("overdue task must have deadline in response")
	}
	if byID["nodeadline"].Deadline != nil {
		t.Fatal("task without deadline must omit deadline in response")
	}
}

func TestGetDigestWorkspaceNotFound(t *testing.T) {
	h := digestServer(t, newFakeRepo())
	rec := getDigest(t, h, "ghost")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestGetDigestStorageUnavailable(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := NewServer(&config.Config{}, nil, nil, nil, nil, nil, log).Routes()
	rec := getDigest(t, h, "ws-1")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

// --- PATCH /v1/workspaces/{tenant}/digest ---

func patchDigest(t *testing.T, h http.Handler, tenant, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("PATCH", "/v1/workspaces/"+tenant+"/digest",
		strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestUpdateDigestSettingsSuccess(t *testing.T) {
	repo := newFakeRepo("ws-1")
	h := digestServer(t, repo)

	rec := patchDigest(t, h, "ws-1", `{"enabled":true,"time":"17:30"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !repo.digestSettingsSaved.enabled || repo.digestSettingsSaved.time != "17:30" {
		t.Fatalf("saved settings: enabled=%v time=%q",
			repo.digestSettingsSaved.enabled, repo.digestSettingsSaved.time)
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["time"] != "17:30" {
		t.Fatalf("resp time = %v, want 17:30", resp["time"])
	}
}

func TestUpdateDigestSettingsDefaultTime(t *testing.T) {
	repo := newFakeRepo("ws-1")
	h := digestServer(t, repo)

	rec := patchDigest(t, h, "ws-1", `{"enabled":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if repo.digestSettingsSaved.time != "09:00" {
		t.Fatalf("expected default time 09:00, got %q", repo.digestSettingsSaved.time)
	}
}

func TestUpdateDigestSettingsDisable(t *testing.T) {
	repo := newFakeRepo("ws-1")
	h := digestServer(t, repo)

	rec := patchDigest(t, h, "ws-1", `{"enabled":false,"time":"09:00"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if repo.digestSettingsSaved.enabled {
		t.Fatal("digest should be disabled")
	}
}

func TestUpdateDigestSettingsNotFound(t *testing.T) {
	repo := newFakeRepo("ws-1")
	repo.digestSettingsErr = storage.ErrNotFound
	h := digestServer(t, repo)

	rec := patchDigest(t, h, "ws-1", `{"enabled":true,"time":"09:00"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
