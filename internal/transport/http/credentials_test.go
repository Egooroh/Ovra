package http

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ovra/internal/config"
	"ovra/internal/domain"
	"ovra/internal/integrations/yougile"
	"ovra/internal/secret"
	"ovra/internal/storage"
)

// fakeRepo is a minimal in-memory Repository for handler tests.
type fakeRepo struct {
	workspaces map[string]domain.Workspace
	tasks      []domain.Task
	setLogin   string
	setEnc     []byte
	tokenEnc   []byte         // returned by GetYougileTokenEnc
	savedCols  domain.Columns // captured by SetWorkspaceColumns
	users      []domain.User  // returned by ListUsersByTenant
	upserted   domain.User    // captured by UpsertUser
}

func newFakeRepo(ids ...string) *fakeRepo {
	m := make(map[string]domain.Workspace)
	for _, id := range ids {
		m[id] = domain.Workspace{ID: id, Name: id}
	}
	return &fakeRepo{workspaces: m}
}

func (f *fakeRepo) GetWorkspace(_ context.Context, id string) (domain.Workspace, error) {
	ws, ok := f.workspaces[id]
	if !ok {
		return domain.Workspace{}, storage.ErrNotFound
	}
	return ws, nil
}

func (f *fakeRepo) SetYougileCredentials(_ context.Context, _ string, login string, enc []byte) error {
	f.setLogin, f.setEnc = login, enc
	return nil
}

// Unused-by-these-tests methods to satisfy storage.Repository.
func (f *fakeRepo) UpsertWorkspace(context.Context, domain.Workspace) error { return nil }
func (f *fakeRepo) SetWorkspaceColumns(_ context.Context, _ string, c domain.Columns) error {
	f.savedCols = c
	return nil
}
func (f *fakeRepo) GetYougileTokenEnc(context.Context, string) (string, []byte, error) {
	return "", f.tokenEnc, nil
}
func (f *fakeRepo) UpsertUser(_ context.Context, u domain.User) (domain.User, error) {
	u.ID = "user-1"
	f.upserted = u
	return u, nil
}
func (f *fakeRepo) GetUser(context.Context, string) (domain.User, error) { return domain.User{}, nil }
func (f *fakeRepo) ListUsersByTenant(context.Context, string) ([]domain.User, error) {
	return f.users, nil
}
func (f *fakeRepo) CreateTask(context.Context, domain.Task) (domain.Task, error) {
	return domain.Task{}, nil
}
func (f *fakeRepo) GetTask(context.Context, string) (domain.Task, error) { return domain.Task{}, nil }
func (f *fakeRepo) UpdateTask(context.Context, domain.Task) (domain.Task, error) {
	return domain.Task{}, nil
}
func (f *fakeRepo) ListTasksByTenant(context.Context, string) ([]domain.Task, error) {
	return f.tasks, nil
}
func (f *fakeRepo) FindSimilarOpenTasks(context.Context, string, string, float64) ([]domain.Task, error) {
	return nil, nil
}
func (f *fakeRepo) ListOpenTasks(context.Context, string, int) ([]domain.Task, error) {
	return nil, nil
}

// testServer wires a Server with a real cipher and a YouGile client pointed at
// the given fake API base URL.
func testServer(t *testing.T, repo storage.Repository, ygBase string) http.Handler {
	t.Helper()
	cipher, err := secret.New("test-secret")
	if err != nil {
		t.Fatal(err)
	}
	yg := yougile.New(yougile.WithBaseURL(ygBase))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewServer(&config.Config{}, repo, cipher, yg, nil, nil, log).Routes()
}

func post(t *testing.T, h http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestSetCredentialsWithAPIKey(t *testing.T) {
	repo := newFakeRepo("ws-1")
	h := testServer(t, repo, "http://unused")

	rec := post(t, h, "/v1/workspaces/ws-1/credentials", `{"api_key":"ready-key-1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// Stored ciphertext must decrypt back to the supplied key.
	cipher, _ := secret.New("test-secret")
	got, err := cipher.Open(repo.setEnc)
	if err != nil || got != "ready-key-1" {
		t.Fatalf("decrypted = %q, err = %v", got, err)
	}
}

func TestSetCredentialsWithLoginPassword(t *testing.T) {
	// Fake YouGile: returns one company, then a generated key.
	yg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/companies":
			_, _ = io.WriteString(w, `{"content":[{"id":"co-1","name":"Acme"}]}`)
		case "/auth/keys":
			_, _ = io.WriteString(w, `{"key":"generated-key-9"}`)
		default:
			http.Error(w, "unexpected", http.StatusNotFound)
		}
	}))
	t.Cleanup(yg.Close)

	repo := newFakeRepo("ws-1")
	h := testServer(t, repo, yg.URL)

	rec := post(t, h, "/v1/workspaces/ws-1/credentials",
		`{"login":"host@acme.com","password":"pw"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if repo.setLogin != "host@acme.com" {
		t.Fatalf("stored login = %q", repo.setLogin)
	}
	cipher, _ := secret.New("test-secret")
	got, _ := cipher.Open(repo.setEnc)
	if got != "generated-key-9" {
		t.Fatalf("decrypted = %q", got)
	}
}

func TestSetCredentialsUnknownTenant(t *testing.T) {
	h := testServer(t, newFakeRepo(), "http://unused")
	rec := post(t, h, "/v1/workspaces/nope/credentials", `{"api_key":"k"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestSetCredentialsMissingFields(t *testing.T) {
	h := testServer(t, newFakeRepo("ws-1"), "http://unused")
	rec := post(t, h, "/v1/workspaces/ws-1/credentials", `{}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
}
