package yougile

import (
	"context"
	"net/http"
	"testing"
)

func TestCreateProjectBoardColumn(t *testing.T) {
	cases := []struct {
		name     string
		call     func(c *Client) (string, error)
		wantPath string
		wantKey  string // a body field that must be present
	}{
		{"project", func(c *Client) (string, error) {
			return c.CreateProject(context.Background(), "tok", "Ovra Demo",
				map[string]string{"u1": "admin"})
		}, "/projects", "users"},
		{"board", func(c *Client) (string, error) {
			return c.CreateBoard(context.Background(), "tok", "Main", "proj-1")
		}, "/boards", "projectId"},
		{"column", func(c *Client) (string, error) {
			return c.CreateColumn(context.Background(), "tok", "Todo", "board-1")
		}, "/columns", "boardId"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var cap capture
			c := fakeServer(t, http.StatusCreated, `{"id":"new-id"}`, &cap)
			id, err := tc.call(c)
			if err != nil {
				t.Fatalf("call: %v", err)
			}
			if id != "new-id" {
				t.Fatalf("id = %q", id)
			}
			if cap.method != "POST" || cap.path != tc.wantPath {
				t.Fatalf("got %s %s", cap.method, cap.path)
			}
			if cap.auth != "Bearer tok" {
				t.Fatalf("auth = %q", cap.auth)
			}
			if _, ok := cap.body[tc.wantKey]; !ok {
				t.Fatalf("missing %q in body %#v", tc.wantKey, cap.body)
			}
		})
	}
}

func TestListColumnsPassesBoardID(t *testing.T) {
	var cap capture
	c := fakeServer(t, http.StatusOK, `{"content":[{"id":"col-1","title":"Todo"}]}`, &cap)

	cols, err := c.ListColumns(context.Background(), "tok", "board-7")
	if err != nil {
		t.Fatalf("ListColumns: %v", err)
	}
	if len(cols) != 1 || cols[0].ID != "col-1" {
		t.Fatalf("cols = %+v", cols)
	}
	if cap.method != "GET" || cap.path != "/columns" {
		t.Fatalf("got %s %s", cap.method, cap.path)
	}
}
