package http

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"ovra/internal/domain"
	"ovra/internal/storage"
)

// createWorkspaceRequest registers a chat as a workspace (bot calls this when an
// admin adds it to a group).
type createWorkspaceRequest struct {
	ChatID   string `json:"chat_id"`
	Name     string `json:"name"`
	HostTgID string `json:"host_tg_id"`
}

// workspaceResponse is the JSON view of a workspace + its onboarding state.
type workspaceResponse struct {
	TenantID         string `json:"tenant_id"`
	ChatID           string `json:"chat_id"`
	Name             string `json:"name"`
	YougileProjectID string `json:"yougile_project_id"`
	HostTgID         string `json:"host_tg_id"`
	Connected        bool   `json:"connected"`      // YouGile credentials set
	BoardResolved    bool   `json:"board_resolved"` // all four columns mapped
	DigestEnabled    bool   `json:"digest_enabled"`
	DigestTime       string `json:"digest_time"`
	ConfirmMode      string `json:"confirm_mode"` // "admin_only" | "everyone"
}

// handleCreateWorkspace creates (or returns) the workspace bound to a chat.
// Idempotent: a second call for the same chat returns the existing workspace.
func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var req createWorkspaceRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.ChatID == "" {
		writeError(w, http.StatusBadRequest, "chat_id is required")
		return
	}

	// Already bound (incl. workspaces seeded from workspace.yaml)?
	if ws, err := s.repo.GetWorkspaceByChat(r.Context(), req.ChatID); err == nil {
		writeJSON(w, http.StatusOK, s.workspaceResp(r.Context(), ws))
		return
	} else if !errors.Is(err, storage.ErrNotFound) {
		s.log.Error("get workspace by chat", "chat", req.ChatID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	ws := domain.Workspace{
		ID:       deriveTenantID(req.ChatID),
		ChatID:   req.ChatID,
		Name:     req.Name,
		HostTgID: req.HostTgID,
	}
	if err := s.repo.UpsertWorkspace(r.Context(), ws); err != nil {
		s.log.Error("create workspace", "chat", req.ChatID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	got, _ := s.repo.GetWorkspace(r.Context(), ws.ID)
	writeJSON(w, http.StatusCreated, s.workspaceResp(r.Context(), got))
}

// handleGetWorkspace returns a workspace (+ onboarding state) by tenant id.
func (s *Server) handleGetWorkspace(w http.ResponseWriter, r *http.Request) {
	ws, err := s.repo.GetWorkspace(r.Context(), r.PathValue("tenant"))
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, s.workspaceResp(r.Context(), ws))
}

// handleWorkspaceByChat resolves the workspace bound to a Telegram chat.
func (s *Server) handleWorkspaceByChat(w http.ResponseWriter, r *http.Request) {
	ws, err := s.repo.GetWorkspaceByChat(r.Context(), r.PathValue("chat_id"))
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "no workspace for this chat")
			return
		}
		s.log.Error("get workspace by chat", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, s.workspaceResp(r.Context(), ws))
}

// handleYouGileUsers lists the YouGile project members (for the user-linking
// buttons in the bot). Needs the workspace to be connected.
func (s *Server) handleYouGileUsers(w http.ResponseWriter, r *http.Request) {
	if s.cipher == nil || s.yg == nil {
		writeError(w, http.StatusServiceUnavailable, "disabled: APP_SECRET not set")
		return
	}
	tenant := r.PathValue("tenant")
	token, ok := s.loadToken(r.Context(), tenant)
	if !ok {
		writeError(w, http.StatusConflict, "workspace is not connected to YouGile")
		return
	}
	users, err := s.yg.ListUsers(r.Context(), token)
	if err != nil {
		writeError(w, http.StatusBadGateway, "yougile: "+err.Error())
		return
	}
	out := make([]map[string]string, len(users))
	for i, u := range users {
		out[i] = map[string]string{"id": u.ID, "name": u.RealName, "email": u.Email}
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

// handleYouGileProjects lists the company's YouGile projects (for the admin to
// pick which one this group maps to).
func (s *Server) handleYouGileProjects(w http.ResponseWriter, r *http.Request) {
	if s.cipher == nil || s.yg == nil {
		writeError(w, http.StatusServiceUnavailable, "disabled: APP_SECRET not set")
		return
	}
	token, ok := s.loadToken(r.Context(), r.PathValue("tenant"))
	if !ok {
		writeError(w, http.StatusConflict, "workspace is not connected to YouGile")
		return
	}
	projects, err := s.yg.ListProjects(r.Context(), token)
	if err != nil {
		writeError(w, http.StatusBadGateway, "yougile: "+err.Error())
		return
	}
	out := make([]map[string]string, len(projects))
	for i, p := range projects {
		out[i] = map[string]string{"id": p.ID, "title": p.Title}
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": out})
}

// setProjectRequest binds a workspace to a YouGile project.
type setProjectRequest struct {
	ProjectID string `json:"project_id"`
}

// handleSetProject stores the chosen project on the workspace.
func (s *Server) handleSetProject(w http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenant")
	var req setProjectRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.ProjectID == "" {
		writeError(w, http.StatusBadRequest, "project_id is required")
		return
	}
	if err := s.repo.SetWorkspaceProject(r.Context(), tenant, req.ProjectID); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("set project", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "set"})
}

// workspaceResp builds the DTO and fills the onboarding-state flags.
func (s *Server) workspaceResp(ctx context.Context, ws domain.Workspace) workspaceResponse {
	connected := false
	if _, enc, err := s.repo.GetYougileTokenEnc(ctx, ws.ID); err == nil && len(enc) > 0 {
		connected = true
	}
	digestTime := ws.DigestTime
	if digestTime == "" {
		digestTime = "09:00"
	}
	return workspaceResponse{
		TenantID:         ws.ID,
		ChatID:           ws.ChatID,
		Name:             ws.Name,
		YougileProjectID: ws.YougileProjectID,
		HostTgID:         ws.HostTgID,
		Connected:        connected,
		BoardResolved:    ws.Columns.Todo != "" && ws.Columns.Done != "",
		DigestEnabled:    ws.DigestEnabled,
		DigestTime:       digestTime,
		ConfirmMode:      confirmMode(ws.ConfirmMode),
	}
}

func confirmMode(m string) string {
	if m == "everyone" {
		return "everyone"
	}
	return "admin_only"
}

// handleSetConfirmMode updates the task-confirmation mode for a workspace.
func (s *Server) handleSetConfirmMode(w http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenant")
	var req struct {
		Mode string `json:"mode"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.Mode != "admin_only" && req.Mode != "everyone" {
		writeError(w, http.StatusBadRequest, `mode must be "admin_only" or "everyone"`)
		return
	}
	if err := s.repo.SetConfirmMode(r.Context(), tenant, req.Mode); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("set confirm mode", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"confirm_mode": req.Mode})
}

// deriveTenantID makes a stable tenant id from a chat id (digits only).
func deriveTenantID(chatID string) string {
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, chatID)
	if digits == "" {
		digits = "x"
	}
	return "tg" + digits
}
