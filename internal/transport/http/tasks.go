package http

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"ovra/internal/domain"
	"ovra/internal/integrations/yougile"
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
	Force       bool   `json:"force"`    // create even if a duplicate is detected
}

// taskResponse is the JSON view of a persisted task.
type taskResponse struct {
	ID             string  `json:"id"`
	TenantID       string  `json:"tenant_id"`
	Title          string  `json:"title"`
	Description    string  `json:"description"`
	Status         string  `json:"status"`
	ApprovalStatus string  `json:"approval_status"`
	AssigneeUserID *string `json:"assignee_user_id,omitempty"`
	Source         string  `json:"source"`
	YougileTaskID  *string `json:"yougile_task_id"`
	Deadline       *string `json:"deadline"`
	DeletedAt      *string `json:"deleted_at,omitempty"`
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
		Force:       req.Force,
	}
	if req.Deadline != "" {
		// Use assignee's timezone if known, otherwise fall back to workspace timezone.
		loc := workspaceLocation("")
		if s.repo != nil {
			if ws, err := s.repo.GetWorkspace(r.Context(), req.TenantID); err == nil {
				loc = workspaceLocation(ws.Timezone)
			}
			if req.Assignee != "" {
				if users, err := s.repo.ListUsersByTenant(r.Context(), req.TenantID); err == nil {
					for _, u := range users {
						if u.Timezone != "" && userMatchesAssignee(u, req.Assignee) {
							loc = workspaceLocation(u.Timezone)
							break
						}
					}
				}
			}
		}
		dl, hasTime, err := parseDeadline(req.Deadline, loc)
		if err != nil {
			writeError(w, http.StatusBadRequest, "deadline must be a date (2026-06-10), datetime (2026-06-10T18:00) or RFC3339")
			return
		}
		in.Deadline = &dl
		in.DeadlineHasTime = hasTime
	}

	task, err := s.tasks.CreateAndPublish(r.Context(), in)
	if err != nil {
		s.writeCreateTaskError(w, task, err)
		return
	}
	writeJSON(w, http.StatusCreated, toTaskResponse(task))
}

// updateTaskRequest is the body of PATCH /v1/tasks/{id}.
// Status-only updates use the task service (YouGile sync included).
// Full-field updates (title / description / assignee / deadline) only need the repo;
// if status also changes, the YouGile card is synced as a best-effort step.
// Pointer fields: nil = don't change; non-nil = apply (empty string = clear).
type updateTaskRequest struct {
	Status         string  `json:"status"`
	Title          *string `json:"title"`
	Description    *string `json:"description"`
	AssigneeUserID *string `json:"assignee_user_id"`
	Deadline       *string `json:"deadline"` // nil=no-op, ""=clear, else RFC3339/date
}

// handleGetTask returns a single task by ID.
func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeError(w, http.StatusServiceUnavailable, "storage unavailable")
		return
	}
	id := r.PathValue("id")
	task, err := s.repo.GetTask(r.Context(), id)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "task not found")
			return
		}
		s.log.Error("get task", "task_id", id, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, toTaskResponse(task))
}

// handleUpdateTask changes task fields and optionally moves its YouGile card.
func (s *Server) handleUpdateTask(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeError(w, http.StatusServiceUnavailable, "storage unavailable")
		return
	}

	id := r.PathValue("id")
	var req updateTaskRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Fast path: status-only update delegates to the task service (YouGile sync).
	if req.Status != "" && req.Title == nil && req.Description == nil && req.AssigneeUserID == nil && req.Deadline == nil {
		if s.tasks == nil {
			writeError(w, http.StatusServiceUnavailable, "task updates disabled: APP_SECRET not set")
			return
		}
		task, err := s.tasks.UpdateStatus(r.Context(), id, req.Status)
		if err != nil {
			s.writeUpdateTaskError(w, task, err)
			return
		}
		writeJSON(w, http.StatusOK, toTaskResponse(task))
		return
	}

	// Full field update.
	task, err := s.repo.GetTask(r.Context(), id)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "task not found")
			return
		}
		s.log.Error("get task for update", "task_id", id, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	oldStatus := task.Status

	if req.Title != nil {
		if *req.Title == "" {
			writeError(w, http.StatusBadRequest, "title cannot be empty")
			return
		}
		task.Title = *req.Title
	}
	if req.Description != nil {
		task.Description = *req.Description
	}
	if req.AssigneeUserID != nil {
		if *req.AssigneeUserID == "" {
			task.AssigneeUserID = nil
		} else {
			uid := *req.AssigneeUserID
			task.AssigneeUserID = &uid
		}
	}
	if req.Deadline != nil {
		if *req.Deadline == "" {
			task.Deadline = nil
		} else {
			loc := workspaceLocation("")
			if ws, wsErr := s.repo.GetWorkspace(r.Context(), task.TenantID); wsErr == nil {
				loc = workspaceLocation(ws.Timezone)
			}
			dl, _, dlErr := parseDeadline(*req.Deadline, loc)
			if dlErr != nil {
				writeError(w, http.StatusBadRequest, "deadline must be a date (2006-01-02), datetime or RFC3339")
				return
			}
			task.Deadline = &dl
		}
	}
	if req.Status != "" {
		switch req.Status {
		case domain.StatusTodo, domain.StatusInProgress, domain.StatusReview, domain.StatusDone:
		default:
			writeError(w, http.StatusBadRequest, "status must be one of: todo, in_progress, review, done")
			return
		}
		task.Status = req.Status
	}

	task, err = s.repo.UpdateTask(r.Context(), task)
	if err != nil {
		s.log.Error("update task fields", "task_id", id, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Sync YouGile card column when status changed (best-effort).
	if req.Status != "" && req.Status != oldStatus {
		s.syncCardStatus(r.Context(), task, req.Status)
	}

	// Sync title/description/deadline/assignee changes to YouGile (best-effort).
	fieldChanged := req.Title != nil || req.Description != nil || req.Deadline != nil || req.AssigneeUserID != nil
	if fieldChanged {
		s.syncCardFields(r.Context(), task, req)
	}

	writeJSON(w, http.StatusOK, toTaskResponse(task))
}

// syncCardStatus moves a YouGile card to the column matching status and marks
// it completed if status == "done". Best-effort: errors are only logged.
func (s *Server) syncCardStatus(ctx context.Context, task domain.Task, status string) {
	if s.yg == nil || s.cipher == nil {
		return
	}
	if task.YougileTaskID == nil || *task.YougileTaskID == "" {
		return
	}
	ws, err := s.repo.GetWorkspace(ctx, task.TenantID)
	if err != nil {
		return
	}
	token, ok := s.loadToken(ctx, task.TenantID)
	if !ok {
		return
	}
	col := ""
	switch status {
	case domain.StatusTodo:
		col = ws.Columns.Todo
	case domain.StatusInProgress:
		col = ws.Columns.InProgress
	case domain.StatusReview:
		col = ws.Columns.Review
	case domain.StatusDone:
		col = ws.Columns.Done
	}
	if col != "" {
		if err := s.yg.MoveTask(ctx, token, *task.YougileTaskID, col); err != nil {
			s.log.Warn("syncCardStatus: move", "task_id", task.ID, "err", err)
		}
	}
	if status == domain.StatusDone {
		if err := s.yg.CompleteTask(ctx, token, *task.YougileTaskID); err != nil {
			s.log.Warn("syncCardStatus: complete", "task_id", task.ID, "err", err)
		}
	}
}

// syncCardFields pushes title/description/deadline/assignee changes to the
// corresponding YouGile card. Best-effort: errors are only logged.
func (s *Server) syncCardFields(ctx context.Context, task domain.Task, req updateTaskRequest) {
	if s.yg == nil || s.cipher == nil {
		return
	}
	if task.YougileTaskID == nil || *task.YougileTaskID == "" {
		return
	}
	token, ok := s.loadToken(ctx, task.TenantID)
	if !ok {
		return
	}

	var assigned []string
	if req.AssigneeUserID != nil {
		if *req.AssigneeUserID == "" {
			assigned = []string{} // clear assignee
		} else {
			if u, err := s.repo.GetUser(ctx, *req.AssigneeUserID); err == nil && u.YougileUserID != "" {
				assigned = []string{u.YougileUserID}
			}
		}
	}

	var dl *yougile.Deadline
	clearDeadline := false
	if req.Deadline != nil {
		if *req.Deadline == "" {
			clearDeadline = true
		} else if task.Deadline != nil {
			dl = yougile.DeadlineFromTime(*task.Deadline, false)
		}
	}

	if err := s.yg.UpdateTaskFields(ctx, token, *task.YougileTaskID, req.Title, req.Description, assigned, dl, clearDeadline); err != nil {
		s.log.Warn("syncCardFields", "task_id", task.ID, "err", err)
	}
}

// writeUpdateTaskError maps an update failure to an HTTP status.
func (s *Server) writeUpdateTaskError(w http.ResponseWriter, task domain.Task, err error) {
	switch {
	case errors.Is(err, service.ErrInvalidStatus):
		writeError(w, http.StatusBadRequest, "status must be one of: todo, in_progress, review, done")
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "task not found")
	case errors.Is(err, service.ErrNoCredentials):
		writeError(w, http.StatusConflict, "workspace is not connected to YouGile")
	case task.ID != "":
		// Status saved in the DB but the YouGile card move failed.
		s.log.Error("move yougile card", "task_id", task.ID, "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": "status saved but YouGile card move failed: " + err.Error(),
			"task":  toTaskResponse(task),
		})
	default:
		s.log.Error("update task", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

// handleListTrash returns tasks currently in the trash for a tenant.
func (s *Server) handleListTrash(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeError(w, http.StatusServiceUnavailable, "storage unavailable")
		return
	}
	tasks, err := s.repo.ListTrashTasks(r.Context(), r.PathValue("tenant"))
	if err != nil {
		s.log.Error("list trash", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tasks": toTaskResponses(tasks)})
}

// handleClearTrash immediately removes all trashed tasks for a tenant.
func (s *Server) handleClearTrash(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeError(w, http.StatusServiceUnavailable, "storage unavailable")
		return
	}
	n, err := s.repo.ClearTrash(r.Context(), r.PathValue("tenant"))
	if err != nil {
		s.log.Error("clear trash", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n})
}

// handleDeleteTask soft-deletes a task (moves it to the 24-h trash).
func (s *Server) handleDeleteTask(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeError(w, http.StatusServiceUnavailable, "storage unavailable")
		return
	}
	id := r.PathValue("id")
	task, err := s.repo.SoftDeleteTask(r.Context(), id)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "task not found")
			return
		}
		s.log.Error("soft delete task", "task_id", id, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Mirror the deletion into YouGile so the card disappears there too.
	// Best-effort: a YouGile failure must not fail the local delete.
	if s.yg != nil && s.cipher != nil && task.YougileTaskID != nil && *task.YougileTaskID != "" {
		if token, ok := s.loadToken(r.Context(), task.TenantID); ok {
			if err := s.yg.DeleteTask(r.Context(), token, *task.YougileTaskID); err != nil {
				s.log.Error("yougile delete task", "task_id", id, "yougile_id", *task.YougileTaskID, "err", err)
			}
		}
	}

	writeJSON(w, http.StatusOK, toTaskResponse(task))
}

// handleListTasks returns the tasks of a workspace (for the digest, FR-7).
func (s *Server) handleListTasks(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeError(w, http.StatusServiceUnavailable, "storage unavailable")
		return
	}
	tenant := r.PathValue("tenant")
	tasks, err := s.repo.ListTasksByTenant(r.Context(), tenant)
	if err != nil {
		s.log.Error("list tasks", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	resp := make([]taskResponse, len(tasks))
	for i, t := range tasks {
		resp[i] = toTaskResponse(t)
	}
	writeJSON(w, http.StatusOK, map[string]any{"tasks": resp})
}

// writeCreateTaskError maps a publish failure to an HTTP status.
func (s *Server) writeCreateTaskError(w http.ResponseWriter, task domain.Task, err error) {
	var dup *service.DuplicateError
	switch {
	case errors.As(err, &dup):
		// Similar tasks exist — let the host decide (resend with force:true).
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":      "similar task(s) already exist; resend with \"force\":true to create anyway",
			"duplicates": toTaskResponses(dup.Candidates),
		})
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

// workspaceLocation resolves a workspace timezone (IANA name), falling back to
// the global DEADLINE_TZ, then UTC.
func workspaceLocation(tz string) *time.Location {
	if tz == "" {
		tz = os.Getenv("DEADLINE_TZ")
	}
	if tz == "" {
		tz = "Europe/Moscow"
	}
	if loc, err := time.LoadLocation(tz); err == nil {
		return loc
	}
	return time.UTC
}

// userMatchesAssignee reports whether u matches the assignee string from the bot
// (tg_username with/without "@", full name, or first name).
func userMatchesAssignee(u domain.User, name string) bool {
	want := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(name)), "@")
	uname := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(u.TgUsername)), "@")
	full := strings.ToLower(strings.TrimSpace(u.FullName))
	if full == want || uname == want {
		return true
	}
	if parts := strings.Fields(full); len(parts) > 0 && parts[0] == want {
		return true
	}
	return false
}

// parseDeadline accepts a date (2006-01-02), a datetime without timezone
// (interpreted in loc) or a full RFC3339 timestamp. hasTime is false for a
// date-only value, so YouGile shows just the date.
func parseDeadline(s string, loc *time.Location) (t time.Time, hasTime bool, err error) {
	if t, err = time.Parse(time.RFC3339, s); err == nil {
		return t, true, nil
	}
	for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02T15:04"} {
		if t, err = time.ParseInLocation(layout, s, loc); err == nil {
			return t, true, nil
		}
	}
	if t, err = time.Parse("2006-01-02", s); err == nil {
		return t, false, nil // date only — no time component
	}
	return time.Time{}, false, fmt.Errorf("unrecognized deadline %q", s)
}

// toTaskResponses maps a slice of tasks to their JSON view.
func toTaskResponses(ts []domain.Task) []taskResponse {
	out := make([]taskResponse, len(ts))
	for i, t := range ts {
		out[i] = toTaskResponse(t)
	}
	return out
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
		AssigneeUserID: t.AssigneeUserID,
		Source:         t.Source,
		YougileTaskID:  t.YougileTaskID,
		CreatedAt:      t.CreatedAt.Format(time.RFC3339),
		UpdatedAt:      t.UpdatedAt.Format(time.RFC3339),
	}
	if t.Deadline != nil {
		dl := t.Deadline.Format(time.RFC3339)
		resp.Deadline = &dl
	}
	if t.DeletedAt != nil {
		da := t.DeletedAt.Format(time.RFC3339)
		resp.DeletedAt = &da
	}
	return resp
}
