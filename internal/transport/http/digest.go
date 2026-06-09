package http

import (
	"errors"
	"net/http"
	"time"

	"ovra/internal/domain"
	"ovra/internal/storage"
)

// digestTaskItem is one task entry in the digest response.
type digestTaskItem struct {
	ID     string  `json:"id"`
	Title  string  `json:"title"`
	Status string  `json:"status"`
	// Deadline is RFC3339 or omitted when not set.
	Deadline *string `json:"deadline,omitempty"`
	// Overdue is true when deadline is in the past.
	Overdue bool `json:"overdue"`
}

// digestAssignee groups tasks by their assignee for the digest.
type digestAssignee struct {
	FullName   string           `json:"full_name"`
	TgUsername string           `json:"tg_username"`
	Tasks      []digestTaskItem `json:"tasks"`
}

// digestResponse is the payload for GET /v1/workspaces/{tenant}/digest.
type digestResponse struct {
	TenantID     string           `json:"tenant_id"`
	DigestTime   string           `json:"digest_time"`
	DigestEnabled bool            `json:"digest_enabled"`
	Assignees    []digestAssignee `json:"assignees"`
	Unassigned   []digestTaskItem `json:"unassigned"`
}

// handleGetDigest returns open approved tasks grouped by assignee for the daily digest.
func (s *Server) handleGetDigest(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeError(w, http.StatusServiceUnavailable, "storage unavailable")
		return
	}
	tenant := r.PathValue("tenant")

	ws, err := s.repo.GetWorkspace(r.Context(), tenant)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace for digest", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	tasks, err := s.repo.ListDigestTasks(r.Context(), tenant)
	if err != nil {
		s.log.Error("list digest tasks", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	users, err := s.repo.ListUsersByTenant(r.Context(), tenant)
	if err != nil {
		s.log.Error("list users for digest", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	userByID := make(map[string]domain.User, len(users))
	for _, u := range users {
		userByID[u.ID] = u
	}

	now := time.Now()
	assigneeMap := make(map[string]*digestAssignee)
	var unassigned []digestTaskItem

	for _, t := range tasks {
		item := toDigestItem(t, now)
		if t.AssigneeUserID == nil {
			unassigned = append(unassigned, item)
			continue
		}
		uid := *t.AssigneeUserID
		if _, ok := assigneeMap[uid]; !ok {
			u := userByID[uid]
			assigneeMap[uid] = &digestAssignee{
				FullName:   u.FullName,
				TgUsername: u.TgUsername,
			}
		}
		assigneeMap[uid].Tasks = append(assigneeMap[uid].Tasks, item)
	}

	// Deterministic order: sort by full name.
	assignees := make([]digestAssignee, 0, len(assigneeMap))
	for _, u := range users {
		if a, ok := assigneeMap[u.ID]; ok {
			assignees = append(assignees, *a)
		}
	}

	digestTime := ws.DigestTime
	if digestTime == "" {
		digestTime = "09:00"
	}

	writeJSON(w, http.StatusOK, digestResponse{
		TenantID:      tenant,
		DigestTime:    digestTime,
		DigestEnabled: ws.DigestEnabled,
		Assignees:     assignees,
		Unassigned:    unassigned,
	})
}

// updateDigestSettingsRequest is the body of PATCH /v1/workspaces/{tenant}/digest.
type updateDigestSettingsRequest struct {
	Enabled bool   `json:"enabled"`
	// Time is "HH:MM" in the workspace timezone.
	Time string `json:"time"`
}

// handleUpdateDigestSettings updates digest enabled/time for a workspace.
func (s *Server) handleUpdateDigestSettings(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeError(w, http.StatusServiceUnavailable, "storage unavailable")
		return
	}
	tenant := r.PathValue("tenant")

	var req updateDigestSettingsRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	digestTime := req.Time
	if digestTime == "" {
		digestTime = "09:00"
	}

	if err := s.repo.SetDigestSettings(r.Context(), tenant, req.Enabled, digestTime); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("set digest settings", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": req.Enabled,
		"time":    digestTime,
	})
}

func toDigestItem(t domain.Task, now time.Time) digestTaskItem {
	item := digestTaskItem{
		ID:     t.ID,
		Title:  t.Title,
		Status: t.Status,
	}
	if t.Deadline != nil {
		dl := t.Deadline.Format(time.RFC3339)
		item.Deadline = &dl
		item.Overdue = t.Deadline.Before(now)
	}
	return item
}
