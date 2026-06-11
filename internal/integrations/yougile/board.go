package yougile

import (
	"context"
	"errors"
	"net/url"
)

// Project / Board / Column are the YouGile hierarchy above a task:
// company → project → board → column → task.

// Project is a YouGile project.
type Project struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// Board is a board inside a project.
type Board struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// Column is a board column (a task status lane). Color is YouGile's palette
// index (1–16); 0 when unset.
type Column struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Color int    `json:"color"`
}

// idResponse is the common {"id": "..."} create response.
type idResponse struct {
	ID string `json:"id"`
}

// CreateProject creates a project and returns its id. POST /projects.
//
// users maps YouGile user id → role (e.g. "admin"). It must include at least
// the creator, otherwise YouGile creates the project with no access and it is
// invisible in the UI.
func (c *Client) CreateProject(ctx context.Context, token, title string, users map[string]string) (string, error) {
	body := map[string]any{"title": title}
	if len(users) > 0 {
		body["users"] = users
	}
	return c.createNamed(ctx, token, "/projects", body, "project")
}

// CreateBoard creates a board inside a project. POST /boards.
func (c *Client) CreateBoard(ctx context.Context, token, title, projectID string) (string, error) {
	return c.createNamed(ctx, token, "/boards",
		map[string]any{"title": title, "projectId": projectID}, "board")
}

// CreateColumn creates a column on a board. POST /columns.
func (c *Client) CreateColumn(ctx context.Context, token, title, boardID string) (string, error) {
	return c.createNamed(ctx, token, "/columns",
		map[string]any{"title": title, "boardId": boardID}, "column")
}

// ListProjects returns the company's projects. GET /projects.
func (c *Client) ListProjects(ctx context.Context, token string) ([]Project, error) {
	if token == "" {
		return nil, errors.New("yougile: missing token")
	}
	var env listEnvelope[Project]
	if err := c.do(ctx, "GET", "/projects", token, nil, &env); err != nil {
		return nil, err
	}
	return env.Content, nil
}

// ListBoards returns the boards of a project. GET /boards?projectId=...
func (c *Client) ListBoards(ctx context.Context, token, projectID string) ([]Board, error) {
	if token == "" {
		return nil, errors.New("yougile: missing token")
	}
	path := "/boards"
	if projectID != "" {
		path += "?projectId=" + url.QueryEscape(projectID)
	}
	var env listEnvelope[Board]
	if err := c.do(ctx, "GET", path, token, nil, &env); err != nil {
		return nil, err
	}
	return env.Content, nil
}

// ListColumns returns the columns of a board. GET /columns?boardId=...
func (c *Client) ListColumns(ctx context.Context, token, boardID string) ([]Column, error) {
	if token == "" {
		return nil, errors.New("yougile: missing token")
	}
	path := "/columns"
	if boardID != "" {
		path += "?boardId=" + url.QueryEscape(boardID)
	}
	var env listEnvelope[Column]
	if err := c.do(ctx, "GET", path, token, nil, &env); err != nil {
		return nil, err
	}
	return env.Content, nil
}

// createNamed POSTs a create request and returns the new id.
func (c *Client) createNamed(ctx context.Context, token, path string, body map[string]any, kind string) (string, error) {
	if token == "" {
		return "", errors.New("yougile: missing token")
	}
	var resp idResponse
	if err := c.do(ctx, "POST", path, token, body, &resp); err != nil {
		return "", err
	}
	if resp.ID == "" {
		return "", errors.New("yougile: empty id in create " + kind + " response")
	}
	return resp.ID, nil
}
