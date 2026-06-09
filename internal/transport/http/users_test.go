package http

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"ovra/internal/domain"
	"ovra/internal/secret"
	_ "ovra/internal/storage" // ErrNotFound used via fakeRepo
)

func TestRegisterUserExplicitYouGileID(t *testing.T) {
	repo := newFakeRepo("ws-1")
	h := testServer(t, repo, "http://unused")

	rec := post(t, h, "/v1/workspaces/ws-1/users",
		`{"tg_id":"123","tg_username":"@vanya","full_name":"Иван Петров","yougile_user_id":"yg-1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if repo.upserted.TgID != "123" || repo.upserted.YougileUserID != "yg-1" {
		t.Fatalf("upserted = %+v", repo.upserted)
	}
}

func TestRegisterUserAutoMapsByName(t *testing.T) {
	// No yougile_user_id in body → backend maps by name against YouGile members.
	yg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/users" {
			_, _ = io.WriteString(w, `{"content":[{"id":"yg-9","realName":"Иван Петров"}]}`)
			return
		}
		http.Error(w, "no", http.StatusNotFound)
	}))
	t.Cleanup(yg.Close)

	repo := newFakeRepo("ws-1")
	cipher, _ := secret.New("test-secret")
	repo.tokenEnc, _ = cipher.Seal("tok")

	h := testServer(t, repo, yg.URL)
	rec := post(t, h, "/v1/workspaces/ws-1/users",
		`{"tg_id":"123","full_name":"Иван Петров"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if repo.upserted.YougileUserID != "yg-9" {
		t.Fatalf("auto-map failed: %+v", repo.upserted)
	}
}

func TestRegisterUserMissingFields(t *testing.T) {
	h := testServer(t, newFakeRepo("ws-1"), "http://unused")
	rec := post(t, h, "/v1/workspaces/ws-1/users", `{"tg_username":"@x"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestRegisterUserUnknownWorkspace(t *testing.T) {
	h := testServer(t, newFakeRepo(), "http://unused")
	rec := post(t, h, "/v1/workspaces/ghost/users", `{"tg_id":"1","full_name":"X"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestRegisterUserAdminRole(t *testing.T) {
	repo := newFakeRepo("ws-1")
	h := testServer(t, repo, "http://unused")

	rec := post(t, h, "/v1/workspaces/ws-1/users",
		`{"tg_id":"1","full_name":"Иван","role":"admin"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if repo.upserted.Role != domain.RoleAdmin {
		t.Fatalf("role = %q, want admin", repo.upserted.Role)
	}
	var resp userResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Role != domain.RoleAdmin {
		t.Fatalf("resp.role = %q, want admin", resp.Role)
	}
}

func TestRegisterUserDefaultRole(t *testing.T) {
	repo := newFakeRepo("ws-1")
	h := testServer(t, repo, "http://unused")

	rec := post(t, h, "/v1/workspaces/ws-1/users",
		`{"tg_id":"2","full_name":"Пётр"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if repo.upserted.Role != domain.RoleMember {
		t.Fatalf("role = %q, want member", repo.upserted.Role)
	}
}

func TestRegisterUserInvalidRoleDefaultsToMember(t *testing.T) {
	repo := newFakeRepo("ws-1")
	h := testServer(t, repo, "http://unused")

	rec := post(t, h, "/v1/workspaces/ws-1/users",
		`{"tg_id":"3","full_name":"Анна","role":"superuser"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if repo.upserted.Role != domain.RoleMember {
		t.Fatalf("invalid role should default to member, got %q", repo.upserted.Role)
	}
}

func TestListUsers(t *testing.T) {
	repo := newFakeRepo("ws-1")
	repo.users = []domain.User{
		{ID: "u1", TenantID: "ws-1", FullName: "A", YougileUserID: "yg-a"},
		{ID: "u2", TenantID: "ws-1", FullName: "B"},
	}
	h := testServer(t, repo, "http://unused")

	req := httptest.NewRequest("GET", "/v1/workspaces/ws-1/users", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body struct {
		Users []userResponse `json:"users"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Users) != 2 || body.Users[0].ID != "u1" {
		t.Fatalf("users = %+v", body.Users)
	}
}
