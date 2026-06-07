package http

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"ovra/internal/domain"
	"ovra/internal/secret"
)

// fakeYouGileBoard serves /boards and /columns for the resolve handler.
func fakeYouGileBoard(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/boards":
			_, _ = io.WriteString(w, `{"content":[{"id":"board-1","title":"Main"}]}`)
		case "/columns":
			_, _ = io.WriteString(w, `{"content":[
				{"id":"c-todo","title":"Сделать"},
				{"id":"c-prog","title":"В работе"},
				{"id":"c-rev","title":"Ревью"},
				{"id":"c-done","title":"Готово"}]}`)
		default:
			http.Error(w, "unexpected", http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestResolveBoardAutoMaps(t *testing.T) {
	yg := fakeYouGileBoard(t)
	repo := newFakeRepo("ws-1")
	repo.workspaces["ws-1"] = domain.Workspace{ID: "ws-1", YougileProjectID: "proj-1"}
	cipher, _ := secret.New("test-secret")
	repo.tokenEnc, _ = cipher.Seal("tok") // testServer uses the same secret

	h := testServer(t, repo, yg.URL)
	rec := post(t, h, "/v1/workspaces/ws-1/board/resolve", ``)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var body struct {
		Confident bool           `json:"confident"`
		Mapping   domain.Columns `json:"mapping"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Confident {
		t.Fatal("expected confident mapping")
	}
	want := domain.Columns{Todo: "c-todo", InProgress: "c-prog", Review: "c-rev", Done: "c-done"}
	if body.Mapping != want {
		t.Fatalf("mapping = %+v", body.Mapping)
	}
	if repo.savedCols != want {
		t.Fatalf("saved cols = %+v", repo.savedCols)
	}
}

func TestResolveBoardManualOverride(t *testing.T) {
	repo := newFakeRepo("ws-1")
	h := testServer(t, repo, "http://unused")

	rec := post(t, h, "/v1/workspaces/ws-1/board/resolve",
		`{"todo":"a","in_progress":"b","review":"c","done":"d"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	want := domain.Columns{Todo: "a", InProgress: "b", Review: "c", Done: "d"}
	if repo.savedCols != want {
		t.Fatalf("saved cols = %+v", repo.savedCols)
	}
}

func TestResolveBoardNoCredentials(t *testing.T) {
	repo := newFakeRepo("ws-1") // tokenEnc nil → not connected
	h := testServer(t, repo, "http://unused")
	rec := post(t, h, "/v1/workspaces/ws-1/board/resolve", ``)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}
