package yougile

import (
	"context"
	"errors"
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

// MoveTask moves a card to another column.
func (c *Client) MoveTask(ctx context.Context, token, id, columnID string) error {
	return c.UpdateTask(ctx, token, id, UpdateTaskRequest{ColumnID: &columnID})
}

// CompleteTask marks a card as completed.
func (c *Client) CompleteTask(ctx context.Context, token, id string) error {
	done := true
	return c.UpdateTask(ctx, token, id, UpdateTaskRequest{Completed: &done})
}

// DeadlineFromTime builds a Deadline (with time) from t.
func DeadlineFromTime(t time.Time) *Deadline {
	return &Deadline{Deadline: t.UnixMilli(), WithTime: true}
}
