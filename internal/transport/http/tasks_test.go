package http

import (
	"context"
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
	"ovra/internal/service"
	"ovra/internal/storage"
)

// fakePublisher is a stand-in for *service.Tasks.
type fakePublisher struct {
	in         service.TaskInput
	task       domain.Task
	err        error
	gotID      string
	gotStatus  string
	statusTask domain.Task
	statusErr  error
}

func (f *fakePublisher) CreateAndPublish(_ context.Context, in service.TaskInput) (domain.Task, error) {
	f.in = in
	return f.task, f.err
}

func (f *fakePublisher) UpdateStatus(_ context.Context, id, status string) (domain.Task, error) {
	f.gotID, f.gotStatus = id, status
	return f.statusTask, f.statusErr
}

func taskServer(t *testing.T, pub TaskService) http.Handler {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewServer(&config.Config{}, nil, nil, nil, pub, nil, log).Routes()
}

// patch issues a PATCH request.
func patch(t *testing.T, h http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("PATCH", path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestCreateTaskSuccess(t *testing.T) {
	cardID := "card-1"
	pub := &fakePublisher{task: domain.Task{
		ID: "t1", TenantID: "ws-1", Title: "Do X",
		Status: domain.StatusTodo, ApprovalStatus: domain.ApprovalApproved,
		Source: domain.SourceChat, YougileTaskID: &cardID,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}}
	h := taskServer(t, pub)

	rec := post(t, h, "/v1/tasks",
		`{"tenant_id":"ws-1","title":"Do X","assignee":"Иван","deadline":"2026-06-10T18:00:00Z"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// Input forwarded to the service, including parsed deadline.
	if pub.in.TenantID != "ws-1" || pub.in.Assignee != "Иван" {
		t.Fatalf("forwarded input = %+v", pub.in)
	}
	if pub.in.Deadline == nil || pub.in.Deadline.UTC().Format(time.RFC3339) != "2026-06-10T18:00:00Z" {
		t.Fatalf("deadline = %v", pub.in.Deadline)
	}
	var resp taskResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ID != "t1" || resp.YougileTaskID == nil || *resp.YougileTaskID != "card-1" {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestCreateTaskMissingFields(t *testing.T) {
	h := taskServer(t, &fakePublisher{})
	rec := post(t, h, "/v1/tasks", `{"title":"no tenant"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestCreateTaskBadDeadline(t *testing.T) {
	h := taskServer(t, &fakePublisher{})
	rec := post(t, h, "/v1/tasks", `{"tenant_id":"ws-1","title":"x","deadline":"10 June"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestCreateTaskNoCredentials(t *testing.T) {
	h := taskServer(t, &fakePublisher{err: service.ErrNoCredentials})
	rec := post(t, h, "/v1/tasks", `{"tenant_id":"ws-1","title":"x"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}

func TestCreateTaskUnknownWorkspace(t *testing.T) {
	h := taskServer(t, &fakePublisher{err: storage.ErrNotFound})
	rec := post(t, h, "/v1/tasks", `{"tenant_id":"ghost","title":"x"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestCreateTaskPersistedButCardFailed(t *testing.T) {
	// Task has an ID (persisted) but publishing errored → 502 with the task.
	pub := &fakePublisher{
		task: domain.Task{ID: "t9", TenantID: "ws-1", Title: "x", CreatedAt: time.Now(), UpdatedAt: time.Now()},
		err:  io.ErrUnexpectedEOF,
	}
	h := taskServer(t, pub)
	rec := post(t, h, "/v1/tasks", `{"tenant_id":"ws-1","title":"x"}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "t9") {
		t.Fatalf("expected task in body, got %s", rec.Body.String())
	}
}

func TestCreateTaskDisabledWithoutPublisher(t *testing.T) {
	h := taskServer(t, nil)
	rec := post(t, h, "/v1/tasks", `{"tenant_id":"ws-1","title":"x"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestUpdateTaskSuccess(t *testing.T) {
	pub := &fakePublisher{statusTask: domain.Task{
		ID: "t1", TenantID: "ws-1", Title: "x", Status: domain.StatusDone,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}}
	h := taskServer(t, pub)

	rec := patch(t, h, "/v1/tasks/t1", `{"status":"done"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if pub.gotID != "t1" || pub.gotStatus != "done" {
		t.Fatalf("forwarded id=%q status=%q", pub.gotID, pub.gotStatus)
	}
}

func TestUpdateTaskMissingStatus(t *testing.T) {
	h := taskServer(t, &fakePublisher{})
	rec := patch(t, h, "/v1/tasks/t1", `{}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestUpdateTaskInvalidStatus(t *testing.T) {
	h := taskServer(t, &fakePublisher{statusErr: service.ErrInvalidStatus})
	rec := patch(t, h, "/v1/tasks/t1", `{"status":"bogus"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestUpdateTaskNotFound(t *testing.T) {
	h := taskServer(t, &fakePublisher{statusErr: storage.ErrNotFound})
	rec := patch(t, h, "/v1/tasks/ghost", `{"status":"done"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestListTasks(t *testing.T) {
	repo := newFakeRepo("ws-1")
	repo.tasks = []domain.Task{
		{ID: "t1", TenantID: "ws-1", Title: "A", CreatedAt: time.Now(), UpdatedAt: time.Now()},
		{ID: "t2", TenantID: "ws-1", Title: "B", CreatedAt: time.Now(), UpdatedAt: time.Now()},
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := NewServer(&config.Config{}, repo, nil, nil, nil, nil, log).Routes()

	req := httptest.NewRequest("GET", "/v1/workspaces/ws-1/tasks", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body struct {
		Tasks []taskResponse `json:"tasks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Tasks) != 2 || body.Tasks[0].ID != "t1" {
		t.Fatalf("tasks = %+v", body.Tasks)
	}
}
