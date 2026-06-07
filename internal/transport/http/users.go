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
type registerUserRequest struct {
	TgID          string `json:"tg_id"`
	TgUsername    string `json:"tg_username"`
	FullName      string `json:"full_name"`
	YougileUserID string `json:"yougile_user_id"`
}

// userResponse is the JSON view of a registered user.
type userResponse struct {
	ID            string `json:"id"`
	TenantID      string `json:"tenant_id"`
	TgID          string `json:"tg_id"`
	TgUsername    string `json:"tg_username"`
	FullName      string `json:"full_name"`
	YougileUserID string `json:"yougile_user_id"`
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

	u, err := s.repo.UpsertUser(r.Context(), domain.User{
		TenantID:      tenant,
		TgID:          req.TgID,
		TgUsername:    req.TgUsername,
		FullName:      req.FullName,
		YougileUserID: yougileID,
	})
	if err != nil {
		s.log.Error("upsert user", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
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

func toUserResponse(u domain.User) userResponse {
	return userResponse{
		ID:            u.ID,
		TenantID:      u.TenantID,
		TgID:          u.TgID,
		TgUsername:    u.TgUsername,
		FullName:      u.FullName,
		YougileUserID: u.YougileUserID,
	}
}
