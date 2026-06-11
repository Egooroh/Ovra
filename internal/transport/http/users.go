package http

import (
	"context"
	"errors"
	"net/http"

	"ovra/internal/domain"
	"ovra/internal/integrations/yougile"
	"ovra/internal/storage"
)

// registerUserRequest registers a chat member. The bot calls this when it sees
// a person in the chat; yougile_user_id is optional — the backend tries to
// auto-map it by matching full_name against YouGile members.
// role is "admin" or "member" (default "member").
type registerUserRequest struct {
	TgID          string `json:"tg_id"`
	TgUsername    string `json:"tg_username"`
	FullName      string `json:"full_name"`
	YougileUserID string `json:"yougile_user_id"`
	Role          string `json:"role"` // "admin" | "member"; defaults to "member"
}

// userResponse is the JSON view of a registered user.
type userResponse struct {
	ID            string `json:"id"`
	TenantID      string `json:"tenant_id"`
	TgID          string `json:"tg_id"`
	TgUsername    string `json:"tg_username"`
	FullName      string `json:"full_name"`
	YougileUserID string `json:"yougile_user_id"`
	Role          string `json:"role"`
}

// handleRegisterUser upserts a workspace member (keyed by tenant + tg_id).
func (s *Server) handleRegisterUser(w http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenant")

	var req registerUserRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.TgID == "" || req.FullName == "" {
		writeError(w, http.StatusBadRequest, "tg_id and full_name are required")
		return
	}

	if _, err := s.repo.GetWorkspace(r.Context(), tenant); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Best-effort auto-map to a YouGile user by name (only if connected).
	yougileID := req.YougileUserID
	if yougileID == "" {
		yougileID = s.autoMapYouGileUser(r.Context(), tenant, req.FullName)
	}

	role := req.Role
	if role != domain.RoleAdmin && role != domain.RoleModerator && role != domain.RoleMember {
		role = domain.RoleMember
	}

	u, err := s.repo.UpsertUser(r.Context(), domain.User{
		TenantID:      tenant,
		TgID:          req.TgID,
		TgUsername:    req.TgUsername,
		FullName:      req.FullName,
		YougileUserID: yougileID,
		Role:          role,
	})
	if err != nil {
		s.log.Error("upsert user", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Remove any YouGile-sync placeholder that shares the same yougile_user_id.
	if yougileID != "" {
		if err := s.repo.DeletePhantomUser(r.Context(), tenant, yougileID); err != nil {
			s.log.Warn("delete phantom user", "tenant", tenant, "yougile_id", yougileID, "err", err)
		}
	}

	writeJSON(w, http.StatusOK, toUserResponse(u))
}

// handleListUsers returns the registered members of a workspace.
func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenant")
	users, err := s.repo.ListUsersByTenant(r.Context(), tenant)
	if err != nil {
		s.log.Error("list users", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	resp := make([]userResponse, len(users))
	for i, u := range users {
		resp[i] = toUserResponse(u)
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": resp})
}

// autoMapYouGileUser returns the YouGile user id whose realName matches name,
// or "" when the workspace isn't connected or no match is found. Best-effort.
func (s *Server) autoMapYouGileUser(ctx context.Context, tenant, name string) string {
	if s.cipher == nil || s.yg == nil {
		return ""
	}
	token, ok := s.loadToken(ctx, tenant)
	if !ok {
		return ""
	}
	users, err := s.yg.ListUsers(ctx, token)
	if err != nil {
		s.log.Warn("yougile list users for auto-map", "tenant", tenant, "err", err)
		return ""
	}
	if u, ok := yougile.FindUserByName(users, name); ok {
		return u.ID
	}
	return ""
}

// loadToken decrypts the workspace token without writing a response. Returns
// ok=false when the workspace has no credentials or decryption fails.
func (s *Server) loadToken(ctx context.Context, tenant string) (string, bool) {
	_, enc, err := s.repo.GetYougileTokenEnc(ctx, tenant)
	if err != nil || len(enc) == 0 {
		return "", false
	}
	token, err := s.cipher.Open(enc)
	if err != nil {
		return "", false
	}
	return token, true
}

// handleGetUserByTgID looks up a workspace member by their Telegram user id.
func (s *Server) handleGetUserByTgID(w http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenant")
	tgID := r.PathValue("tg_id")
	u, err := s.repo.GetUserByTgID(r.Context(), tenant, tgID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "user not found")
			return
		}
		s.log.Error("get user by tg_id", "tenant", tenant, "tg_id", tgID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, toUserResponse(u))
}

// handleSetUserRole updates the Ovra role (admin/member) of a workspace member.
// The caller must be a workspace admin or the host — enforced by the bot; the
// endpoint is internal so we trust the caller's role check.
func (s *Server) handleSetUserRole(w http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenant")
	tgID := r.PathValue("tg_id")
	var req struct {
		Role string `json:"role"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.Role != domain.RoleAdmin && req.Role != domain.RoleModerator && req.Role != domain.RoleMember {
		writeError(w, http.StatusBadRequest, `role must be "admin", "moderator" or "member"`)
		return
	}
	if err := s.repo.SetUserRole(r.Context(), tenant, tgID, req.Role); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "user not found in workspace")
			return
		}
		s.log.Error("set user role", "tenant", tenant, "tg_id", tgID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"tg_id": tgID, "role": req.Role})
}

func toUserResponse(u domain.User) userResponse {
	return userResponse{
		ID:            u.ID,
		TenantID:      u.TenantID,
		TgID:          u.TgID,
		TgUsername:    u.TgUsername,
		FullName:      u.FullName,
		YougileUserID: u.YougileUserID,
		Role:          u.Role,
	}
}
