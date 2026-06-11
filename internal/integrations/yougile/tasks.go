package yougile

import (
	"context"
	"errors"
	"net/url"
	"time"
)

// Deadline is YouGile's task-deadline object (timestamps are ms since epoch).
type Deadline struct {
	Deadline int64 `json:"deadline"`
	WithTime bool  `json:"withTime"`
}

// CreateTaskRequest is the body for POST /tasks. Title and ColumnID are
// required; the rest are optional.
type CreateTaskRequest struct {
	Title       string    `json:"title"`
	ColumnID    string    `json:"columnId"`
	Description string    `json:"description,omitempty"`
	Assigned    []string  `json:"assigned,omitempty"` // YouGile user IDs
	Deadline    *Deadline `json:"deadline,omitempty"`
}

// CreateTask creates a card and returns its YouGile id. POST /tasks.
func (c *Client) CreateTask(ctx context.Context, token string, req CreateTaskRequest) (string, error) {
	if token == "" {
		return "", errors.New("yougile: missing token")
	}
	if req.Title == "" || req.ColumnID == "" {
		return "", errors.New("yougile: title and columnId are required")
	}
	var resp struct {
		ID string `json:"id"`
	}
	if err := c.do(ctx, "POST", "/tasks", token, req, &resp); err != nil {
		return "", err
	}
	if resp.ID == "" {
		return "", errors.New("yougile: empty id in /tasks response")
	}
	return resp.ID, nil
}

// UpdateTaskRequest is a partial update for PUT /tasks/{id}; nil fields are
// left unchanged.
type UpdateTaskRequest struct {
	ColumnID  *string `json:"columnId,omitempty"`
	Completed *bool   `json:"completed,omitempty"`
	Archived  *bool   `json:"archived,omitempty"`
	Deleted   *bool   `json:"deleted,omitempty"`
}

// UpdateTask applies a partial update. PUT /tasks/{id}.
func (c *Client) UpdateTask(ctx context.Context, token, id string, req UpdateTaskRequest) error {
	if token == "" {
		return errors.New("yougile: missing token")
	}
	if id == "" {
		return errors.New("yougile: missing task id")
	}
	return c.do(ctx, "PUT", "/tasks/"+id, token, req, nil)
}

// UpdateTaskFields syncs title, description, assigned users and deadline to a
// YouGile card. Only non-nil parameters are included in the request body.
// Pass clearDeadline=true to explicitly remove the deadline (sends null).
func (c *Client) UpdateTaskFields(ctx context.Context, token, id string, title, description *string, assigned []string, deadline *Deadline, clearDeadline bool) error {
	if token == "" {
		return errors.New("yougile: missing token")
	}
	if id == "" {
		return errors.New("yougile: missing task id")
	}
	body := map[string]any{}
	if title != nil {
		body["title"] = *title
	}
	if description != nil {
		body["description"] = *description
	}
	if assigned != nil {
		body["assigned"] = assigned
	}
	if clearDeadline {
		body["deadline"] = nil
	} else if deadline != nil {
		body["deadline"] = deadline
	}
	if len(body) == 0 {
		return nil
	}
	return c.do(ctx, "PUT", "/tasks/"+id, token, body, nil)
}

// MoveTask moves a card to another column.
func (c *Client) MoveTask(ctx context.Context, token, id, columnID string) error {
	return c.UpdateTask(ctx, token, id, UpdateTaskRequest{ColumnID: &columnID})
}

// CompleteTask marks a card as completed.
func (c *Client) CompleteTask(ctx context.Context, token, id string) error {
	done := true
	return c.UpdateTask(ctx, token, id, UpdateTaskRequest{Completed: &done})
}

// TaskInfo holds the fields Ovra needs when inspecting an existing card.
type TaskInfo struct {
	ColumnID  string   `json:"columnId"`
	Completed bool     `json:"completed"`
	Archived  bool     `json:"archived"`
	Deleted   bool     `json:"deleted"`  // YouGile soft-delete; board hides it but GET still returns 200
	Assigned  []string `json:"assigned"` // YouGile user IDs (first element is the primary assignee)
}

// UnarchiveTask sets archived=false on a card so it appears on the board again.
func (c *Client) UnarchiveTask(ctx context.Context, token, id string) error {
	archived := false
	return c.UpdateTask(ctx, token, id, UpdateTaskRequest{Archived: &archived})
}

// DeleteTask soft-deletes a card in YouGile (deleted=true). The card moves to
// YouGile's trash; GET still returns 200 with deleted=true until it is purged.
func (c *Client) DeleteTask(ctx context.Context, token, id string) error {
	deleted := true
	return c.UpdateTask(ctx, token, id, UpdateTaskRequest{Deleted: &deleted})
}

// GetTaskRaw fetches the raw JSON map for a card — useful for inspecting
// fields that are not yet in TaskInfo (e.g. deleted, sticker).
func (c *Client) GetTaskRaw(ctx context.Context, token, id string) (map[string]any, error) {
	var resp map[string]any
	if err := c.do(ctx, "GET", "/tasks/"+id, token, nil, &resp); err != nil {
		return nil, err
	}
	return resp, nil
}

// GetTask fetches a card's current state. Returns (nil, nil) when the card
// does not exist (404) or has been soft-deleted by the user (deleted=true).
func (c *Client) GetTask(ctx context.Context, token, id string) (*TaskInfo, error) {
	var resp TaskInfo
	err := c.do(ctx, "GET", "/tasks/"+id, token, nil, &resp)
	if err == nil {
		if resp.Deleted {
			return nil, nil // treat soft-deleted same as missing
		}
		return &resp, nil
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == 404 {
		return nil, nil
	}
	return nil, err
}

// TaskExists reports whether a YouGile card with the given id exists.
// Returns false (not an error) when YouGile responds with 404.
func (c *Client) TaskExists(ctx context.Context, token, id string) (bool, error) {
	info, err := c.GetTask(ctx, token, id)
	if err != nil {
		return false, err
	}
	return info != nil, nil
}

// DeadlineFromTime builds a Deadline from t. withTime controls whether YouGile
// shows the time component (false → date only).
func DeadlineFromTime(t time.Time, withTime bool) *Deadline {
	return &Deadline{Deadline: t.UnixMilli(), WithTime: withTime}
}

// ColumnTask is one task entry returned by ListTasksByColumn.
type ColumnTask struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	ColumnID  string    `json:"columnId"`
	Completed bool      `json:"completed"`
	Archived  bool      `json:"archived"`
	Deleted   bool      `json:"deleted"`
	Assigned  []string  `json:"assigned"`
	Deadline  *Deadline `json:"deadline,omitempty"`
}

// ListTasksByColumn returns all tasks in the given column. GET /tasks?columnId=...
func (c *Client) ListTasksByColumn(ctx context.Context, token, columnID string) ([]ColumnTask, error) {
	if token == "" {
		return nil, errors.New("yougile: missing token")
	}
	if columnID == "" {
		return nil, errors.New("yougile: missing columnId")
	}
	path := "/tasks?columnId=" + url.QueryEscape(columnID)
	var env listEnvelope[ColumnTask]
	if err := c.do(ctx, "GET", path, token, nil, &env); err != nil {
		return nil, err
	}
	return env.Content, nil
}
