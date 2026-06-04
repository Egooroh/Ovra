package http

import (
	"errors"
	"net/http"
	"time"

	"ovra/internal/domain"
	"ovra/internal/service"
	"ovra/internal/storage"
)

// createTaskRequest is the body of POST /v1/tasks — a task approved by the host
// (typically produced by Claude) to be persisted and pushed to YouGile.
type createTaskRequest struct {
	TenantID    string `json:"tenant_id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Assignee    string `json:"assignee"` // human name; mapped to a YouGile user
	Deadline    string `json:"deadline"` // RFC3339, optional
}

// taskResponse is the JSON view of a persisted task.
type taskResponse struct {
	ID             string  `json:"id"`
	TenantID       string  `json:"tenant_id"`
	Title          string  `json:"title"`
	Description    string  `json:"description"`
	Status         string  `json:"status"`
	ApprovalStatus string  `json:"approval_status"`
	Source         string  `json:"source"`
	YougileTaskID  *string `json:"yougile_task_id"`
	Deadline       *string `json:"deadline"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
}

// handleCreateTask persists an approved task and creates its YouGile card.
func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	if s.tasks == nil {
		writeError(w, http.StatusServiceUnavailable, "task publishing disabled: APP_SECRET not set")
		return
	}

	var req createTaskRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.TenantID == "" || req.Title == "" {
		writeError(w, http.StatusBadRequest, "tenant_id and title are required")
		return
	}

	in := service.TaskInput{
		TenantID:    req.TenantID,
		Title:       req.Title,
		Description: req.Description,
		Assignee:    req.Assignee,
		Source:      domain.SourceChat,
	}
	if req.Deadline != "" {
		dl, err := time.Parse(time.RFC3339, req.Deadline)
		if err != nil {
			writeError(w, http.StatusBadRequest, "deadline must be RFC3339, e.g. 2026-06-10T18:00:00Z")
			return
		}
		in.Deadline = &dl
	}

	task, err := s.tasks.CreateAndPublish(r.Context(), in)
	if err != nil {
		s.writeCreateTaskError(w, task, err)
		return
	}
	writeJSON(w, http.StatusCreated, toTaskResponse(task))
}

// writeCreateTaskError maps a publish failure to an HTTP status.
func (s *Server) writeCreateTaskError(w http.ResponseWriter, task domain.Task, err error) {
	switch {
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "workspace not found")
	case errors.Is(err, service.ErrNoCredentials):
		writeError(w, http.StatusConflict, "workspace is not connected to YouGile; set credentials first")
	case task.ID != "":
		// Task was persisted but the YouGile card failed — report it so the
		// caller can retry publishing without recreating the task.
		s.log.Error("publish task to yougile", "task_id", task.ID, "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": "task saved but YouGile card failed: " + err.Error(),
			"task":  toTaskResponse(task),
		})
	default:
		s.log.Error("create task", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

// toTaskResponse converts a domain.Task to its JSON view.
func toTaskResponse(t domain.Task) taskResponse {
	resp := taskResponse{
		ID:             t.ID,
		TenantID:       t.TenantID,
		Title:          t.Title,
		Description:    t.Description,
		Status:         t.Status,
		ApprovalStatus: t.ApprovalStatus,
		Source:         t.Source,
		YougileTaskID:  t.YougileTaskID,
		CreatedAt:      t.CreatedAt.Format(time.RFC3339),
		UpdatedAt:      t.UpdatedAt.Format(time.RFC3339),
	}
	if t.Deadline != nil {
		dl := t.Deadline.Format(time.RFC3339)
		resp.Deadline = &dl
	}
	return resp
}
