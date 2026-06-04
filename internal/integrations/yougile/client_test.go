package yougile

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// capture records the last request a fake server received.
type capture struct {
	method string
	path   string
	auth   string
	body   map[string]any
}

func fakeServer(t *testing.T, status int, respBody string, cap *capture) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.method = r.Method
		cap.path = r.URL.Path
		cap.auth = r.Header.Get("Authorization")
		if b, _ := io.ReadAll(r.Body); len(b) > 0 {
			_ = json.Unmarshal(b, &cap.body)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, respBody)
	}))
	t.Cleanup(srv.Close)
	return New(WithBaseURL(srv.URL))
}

func TestObtainKeyFlow(t *testing.T) {
	// First call lists companies, second creates the key. Use a stateful handler.
	var step int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/companies":
			step++
			_, _ = io.WriteString(w, `{"content":[{"id":"co-1","name":"Acme","isAdmin":true}]}`)
		case "/auth/keys":
			step++
			_, _ = io.WriteString(w, `{"key":"yg-key-123"}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)

	c := New(WithBaseURL(srv.URL))
	key, err := c.ObtainKey(context.Background(), "host@acme.com", "pw", "")
	if err != nil {
		t.Fatalf("ObtainKey: %v", err)
	}
	if key != "yg-key-123" {
		t.Fatalf("key = %q", key)
	}
	if step != 2 {
		t.Fatalf("expected 2 calls, got %d", step)
	}
}

func TestCreateTaskRequestShape(t *testing.T) {
	var cap capture
	c := fakeServer(t, http.StatusCreated, `{"id":"task-42"}`, &cap)

	id, err := c.CreateTask(context.Background(), "tok", CreateTaskRequest{
		Title:       "Ship MVP",
		ColumnID:    "col-todo",
		Description: "do it",
		Assigned:    []string{"u1"},
	})
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if id != "task-42" {
		t.Fatalf("id = %q", id)
	}
	if cap.method != "POST" || cap.path != "/tasks" {
		t.Fatalf("got %s %s", cap.method, cap.path)
	}
	if cap.auth != "Bearer tok" {
		t.Fatalf("auth header = %q", cap.auth)
	}
	if cap.body["title"] != "Ship MVP" || cap.body["columnId"] != "col-todo" {
		t.Fatalf("body = %#v", cap.body)
	}
}

func TestMoveTaskSendsColumnID(t *testing.T) {
	var cap capture
	c := fakeServer(t, http.StatusOK, ``, &cap)

	if err := c.MoveTask(context.Background(), "tok", "task-1", "col-done"); err != nil {
		t.Fatalf("MoveTask: %v", err)
	}
	if cap.method != "PUT" || cap.path != "/tasks/task-1" {
		t.Fatalf("got %s %s", cap.method, cap.path)
	}
	if cap.body["columnId"] != "col-done" {
		t.Fatalf("body = %#v", cap.body)
	}
	if _, ok := cap.body["completed"]; ok {
		t.Fatalf("completed should be omitted, body = %#v", cap.body)
	}
}

func TestListUsersAndFind(t *testing.T) {
	var cap capture
	c := fakeServer(t, http.StatusOK,
		`{"content":[{"id":"u1","email":"a@x.io","realName":"Иван Петров"},{"id":"u2","email":"b@x.io","realName":"Анна Сидорова"}]}`,
		&cap)

	users, err := c.ListUsers(context.Background(), "tok")
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	if cap.auth != "Bearer tok" {
		t.Fatalf("auth = %q", cap.auth)
	}
	u, ok := FindUserByName(users, "  анна сидорова ")
	if !ok || u.ID != "u2" {
		t.Fatalf("FindUserByName = %+v, %v", u, ok)
	}
	if _, ok := FindUserByName(users, "no one"); ok {
		t.Fatal("unexpected match")
	}
}

func TestAPIErrorOnNon2xx(t *testing.T) {
	var cap capture
	c := fakeServer(t, http.StatusUnauthorized, `{"message":"bad token"}`, &cap)

	_, err := c.CreateTask(context.Background(), "tok", CreateTaskRequest{Title: "t", ColumnID: "c"})
	var apiErr *APIError
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("expected APIError 401, got %v", err)
	}
}
