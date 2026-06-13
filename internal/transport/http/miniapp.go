package http

import (
	"crypto/hmac"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"ovra/internal/domain"
	"ovra/internal/integrations/yougile"
	"ovra/internal/storage"
)

//go:embed miniapp.html
var miniappHTML []byte

// ---------------------------------------------------------------------------
// Telegram initData verification
// ---------------------------------------------------------------------------

// parseTelegramInitData parses and cryptographically verifies the initData
// string produced by window.Telegram.WebApp.initData.
// Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
func parseTelegramInitData(initData, botToken string) (url.Values, error) {
	vals, err := url.ParseQuery(initData)
	if err != nil {
		return nil, fmt.Errorf("parse init_data: %w", err)
	}

	received := vals.Get("hash")
	if received == "" {
		return nil, errors.New("init_data: missing hash")
	}
	vals.Del("hash")

	// Build the data-check string: sorted "key=value" lines joined by "\n".
	keys := make([]string, 0, len(vals))
	for k := range vals {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + "=" + vals.Get(k)
	}
	dataCheckString := strings.Join(parts, "\n")

	// secret_key = HMAC-SHA256("WebAppData", bot_token)
	mac1 := hmac.New(sha256.New, []byte("WebAppData"))
	mac1.Write([]byte(botToken))
	secretKey := mac1.Sum(nil)

	// expected = hex(HMAC-SHA256(secret_key, data_check_string))
	mac2 := hmac.New(sha256.New, secretKey)
	mac2.Write([]byte(dataCheckString))
	expected := hex.EncodeToString(mac2.Sum(nil))

	if !hmac.Equal([]byte(expected), []byte(received)) {
		return nil, errors.New("init_data: signature mismatch")
	}

	// Reject stale initData (replay protection). Telegram sets auth_date to
	// the Unix timestamp when the data was signed — discard anything older than 48h.
	authDateStr := vals.Get("auth_date")
	if authDateStr == "" {
		return nil, errors.New("init_data: missing auth_date")
	}
	var authDateUnix int64
	if _, err := fmt.Sscanf(authDateStr, "%d", &authDateUnix); err != nil {
		return nil, errors.New("init_data: invalid auth_date")
	}
	if time.Since(time.Unix(authDateUnix, 0)) > 48*time.Hour {
		return nil, errors.New("init_data: expired (older than 48h)")
	}

	return vals, nil
}

// miniappTgUser is the Telegram user embedded in initData.
type miniappTgUser struct {
	ID        int64  `json:"id"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Username  string `json:"username"`
	PhotoURL  string `json:"photo_url"`
}

func extractTgUser(vals url.Values) (miniappTgUser, error) {
	var u miniappTgUser
	raw := vals.Get("user")
	if raw == "" {
		return u, errors.New("init_data: missing user field")
	}
	if err := json.Unmarshal([]byte(raw), &u); err != nil {
		return u, fmt.Errorf("init_data: decode user: %w", err)
	}
	return u, nil
}

// ---------------------------------------------------------------------------
// GET /miniapp/
// ---------------------------------------------------------------------------

// handleMiniAppPage serves the embedded Telegram Mini App HTML page.
func (s *Server) handleMiniAppPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(miniappHTML)
}

// ---------------------------------------------------------------------------
// POST /miniapp/verify
// ---------------------------------------------------------------------------

type miniappVerifyRequest struct {
	InitData string `json:"init_data"`
	TenantID string `json:"tenant_id"`
}

type miniappVerifyResponse struct {
	User struct {
		ID        int64  `json:"id"`
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name,omitempty"`
		Username  string `json:"username,omitempty"`
		PhotoURL  string `json:"photo_url,omitempty"`
	} `json:"user"`
	Workspace workspaceResponse `json:"workspace"`
	IsAdmin   bool              `json:"is_admin"`
	Role      string            `json:"role"` // "admin" | "moderator" | "member"
}

// handleMiniAppVerify verifies Telegram initData and returns the workspace
// state + whether the caller is the admin (host) of that workspace.
func (s *Server) handleMiniAppVerify(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TelegramBotToken == "" {
		writeError(w, http.StatusServiceUnavailable, "mini-app: TELEGRAM_BOT_TOKEN not configured")
		return
	}

	var req miniappVerifyRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.InitData == "" || req.TenantID == "" {
		writeError(w, http.StatusBadRequest, "init_data and tenant_id are required")
		return
	}

	vals, err := parseTelegramInitData(req.InitData, s.cfg.TelegramBotToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid telegram data: "+err.Error())
		return
	}
	user, err := extractTgUser(vals)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ws, err := s.repo.GetWorkspace(r.Context(), req.TenantID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace (miniapp verify)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	tgIDStr := fmt.Sprintf("%d", user.ID)
	isAdmin := ws.HostTgID == tgIDStr
	role := domain.RoleMember
	if isAdmin {
		role = domain.RoleAdmin
	} else {
		if u, err := s.repo.GetUserByTgID(r.Context(), req.TenantID, tgIDStr); err == nil {
			role = u.Role
			if u.Role == domain.RoleAdmin {
				isAdmin = true
			}
		}
	}

	var resp miniappVerifyResponse
	resp.User.ID = user.ID
	resp.User.FirstName = user.FirstName
	resp.User.LastName = user.LastName
	resp.User.Username = user.Username
	resp.User.PhotoURL = user.PhotoURL
	resp.Workspace = s.workspaceResp(r.Context(), ws)
	resp.IsAdmin = isAdmin
	resp.Role = role

	writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------------------
// POST /miniapp/connect
// ---------------------------------------------------------------------------

type miniappConnectRequest struct {
	InitData    string `json:"init_data"`
	TenantID    string `json:"tenant_id"`
	APIKey      string `json:"api_key"`
	Login       string `json:"login"`
	Password    string `json:"password"`
	CompanyID   string `json:"company_id"`
	CompanyName string `json:"company_name"`
}

// handleMiniAppConnect verifies Telegram initData, confirms the caller is the
// workspace host (admin), then stores the YouGile credentials.
// Accepts either api_key OR login+password (same semantics as handleSetCredentials).
func (s *Server) handleMiniAppConnect(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TelegramBotToken == "" {
		writeError(w, http.StatusServiceUnavailable, "mini-app: TELEGRAM_BOT_TOKEN not configured")
		return
	}
	if s.cipher == nil {
		writeError(w, http.StatusServiceUnavailable, "credential storage disabled: APP_SECRET not set")
		return
	}

	var req miniappConnectRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.InitData == "" || req.TenantID == "" {
		writeError(w, http.StatusBadRequest, "init_data and tenant_id are required")
		return
	}
	if req.APIKey == "" && (req.Login == "" || req.Password == "") {
		writeError(w, http.StatusBadRequest, "provide either api_key, or login and password")
		return
	}

	// Verify Telegram identity.
	vals, err := parseTelegramInitData(req.InitData, s.cfg.TelegramBotToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid telegram data: "+err.Error())
		return
	}
	user, err := extractTgUser(vals)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Load workspace and confirm the caller is the admin.
	ws, err := s.repo.GetWorkspace(r.Context(), req.TenantID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace (miniapp connect)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if ws.HostTgID != fmt.Sprintf("%d", user.ID) {
		writeError(w, http.StatusForbidden, "only the workspace admin can connect the board")
		return
	}

	// Resolve the API key.
	key := req.APIKey
	if key == "" {
		k, err := s.obtainYougileKey(r.Context(), req.Login, req.Password, req.CompanyID, req.CompanyName)
		if err != nil {
			var apiErr *yougile.APIError
			if errors.As(err, &apiErr) {
				writeError(w, http.StatusBadGateway, "yougile rejected credentials: "+apiErr.Error())
				return
			}
			s.log.Error("obtain yougile key (miniapp)", "tenant", req.TenantID, "err", err)
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		key = k
	}

	// Validate the key before persisting.
	if _, err := s.yg.ListProjects(r.Context(), key); err != nil {
		var apiErr *yougile.APIError
		if errors.As(err, &apiErr) &&
			(apiErr.Status == http.StatusUnauthorized || apiErr.Status == http.StatusForbidden) {
			writeError(w, http.StatusBadRequest, "YouGile отклонил ключ (неверный или нет доступа)")
			return
		}
		// Transient network error — warn and store anyway.
		s.log.Warn("validate yougile key (miniapp)", "tenant", req.TenantID, "err", err)
	}

	// Encrypt and persist.
	enc, err := s.cipher.Seal(key)
	if err != nil {
		s.log.Error("seal token (miniapp)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	storedLogin := req.Login // empty string is fine when using a raw api_key
	if err := s.repo.SetYougileCredentials(r.Context(), req.TenantID, storedLogin, enc); err != nil {
		s.log.Error("store credentials (miniapp)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	via := "api_key"
	if req.Login != "" {
		via = "login_password"
	}
	s.log.Info("yougile credentials stored via mini-app", "tenant", req.TenantID, "via", via)
	writeJSON(w, http.StatusOK, map[string]string{"status": "connected"})
}

// ---------------------------------------------------------------------------
// POST /miniapp/workspaces
// ---------------------------------------------------------------------------

type miniappWorkspacesRequest struct {
	InitData string `json:"init_data"`
}

// miniappWorkspaceItem is one row of the Mini App "my boards" list: the standard
// workspace view plus whether the caller is its admin (host).
type miniappWorkspaceItem struct {
	workspaceResponse
	IsAdmin bool `json:"is_admin"`
}

type miniappWorkspacesResponse struct {
	User struct {
		ID        int64  `json:"id"`
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name,omitempty"`
		Username  string `json:"username,omitempty"`
		PhotoURL  string `json:"photo_url,omitempty"`
	} `json:"user"`
	Workspaces []miniappWorkspaceItem `json:"workspaces"`
}

// handleMiniAppWorkspaces verifies Telegram initData and returns every workspace
// the caller belongs to (as host or member). Powers the profile screen opened
// from the bot's menu button, where no tenant is present in the URL.
func (s *Server) handleMiniAppWorkspaces(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TelegramBotToken == "" {
		writeError(w, http.StatusServiceUnavailable, "mini-app: TELEGRAM_BOT_TOKEN not configured")
		return
	}

	var req miniappWorkspacesRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.InitData == "" {
		writeError(w, http.StatusBadRequest, "init_data is required")
		return
	}

	vals, err := parseTelegramInitData(req.InitData, s.cfg.TelegramBotToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid telegram data: "+err.Error())
		return
	}
	user, err := extractTgUser(vals)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	tgID := fmt.Sprintf("%d", user.ID)
	list, err := s.repo.ListWorkspacesForTgUser(r.Context(), tgID)
	if err != nil {
		s.log.Error("list workspaces for tg user (miniapp)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	var resp miniappWorkspacesResponse
	resp.User.ID = user.ID
	resp.User.FirstName = user.FirstName
	resp.User.LastName = user.LastName
	resp.User.Username = user.Username
	resp.User.PhotoURL = user.PhotoURL
	resp.Workspaces = make([]miniappWorkspaceItem, 0, len(list))
	for _, ws := range list {
		resp.Workspaces = append(resp.Workspaces, miniappWorkspaceItem{
			workspaceResponse: s.workspaceResp(r.Context(), ws),
			IsAdmin:           ws.HostTgID == tgID,
		})
	}

	writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------------------
// POST /miniapp/companies
// ---------------------------------------------------------------------------

type miniappCompaniesRequest struct {
	InitData string `json:"init_data"`
	TenantID string `json:"tenant_id"`
	Login    string `json:"login"`
	Password string `json:"password"`
}

// handleMiniAppCompanies verifies the caller is the workspace admin, then lists
// the YouGile companies reachable with the supplied login/password so the admin
// can pick one. The password is used once and never stored.
func (s *Server) handleMiniAppCompanies(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TelegramBotToken == "" {
		writeError(w, http.StatusServiceUnavailable, "mini-app: TELEGRAM_BOT_TOKEN not configured")
		return
	}

	var req miniappCompaniesRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.InitData == "" || req.TenantID == "" {
		writeError(w, http.StatusBadRequest, "init_data and tenant_id are required")
		return
	}
	if req.Login == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "login and password are required")
		return
	}

	vals, err := parseTelegramInitData(req.InitData, s.cfg.TelegramBotToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid telegram data: "+err.Error())
		return
	}
	user, err := extractTgUser(vals)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ws, err := s.repo.GetWorkspace(r.Context(), req.TenantID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace (miniapp companies)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if ws.HostTgID != fmt.Sprintf("%d", user.ID) {
		writeError(w, http.StatusForbidden, "only the workspace admin can connect the board")
		return
	}

	companies, err := s.yg.ListCompanies(r.Context(), req.Login, req.Password)
	if err != nil {
		var apiErr *yougile.APIError
		if errors.As(err, &apiErr) {
			writeError(w, http.StatusBadGateway, "yougile rejected credentials: "+apiErr.Error())
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"companies": companiesView(companies)})
}

// ---------------------------------------------------------------------------
// POST /miniapp/set-role
// ---------------------------------------------------------------------------

type miniappSetRoleRequest struct {
	InitData string `json:"init_data"`
	TenantID string `json:"tenant_id"`
	TgID     string `json:"tg_id"`
	Role     string `json:"role"`
}

// handleMiniAppSetRole verifies the caller is a workspace admin, then updates
// the Ovra role of the target user. Used by the mini-app role management UI.
func (s *Server) handleMiniAppSetRole(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TelegramBotToken == "" {
		writeError(w, http.StatusServiceUnavailable, "mini-app: TELEGRAM_BOT_TOKEN not configured")
		return
	}

	var req miniappSetRoleRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.InitData == "" || req.TenantID == "" || req.TgID == "" || req.Role == "" {
		writeError(w, http.StatusBadRequest, "init_data, tenant_id, tg_id and role are required")
		return
	}
	if req.Role != domain.RoleAdmin && req.Role != domain.RoleModerator && req.Role != domain.RoleMember {
		writeError(w, http.StatusBadRequest, `role must be "admin", "moderator" or "member"`)
		return
	}

	vals, err := parseTelegramInitData(req.InitData, s.cfg.TelegramBotToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid telegram data: "+err.Error())
		return
	}
	caller, err := extractTgUser(vals)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ws, err := s.repo.GetWorkspace(r.Context(), req.TenantID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace (miniapp set-role)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	callerTgID := fmt.Sprintf("%d", caller.ID)
	isAdmin := ws.HostTgID == callerTgID
	if !isAdmin {
		if u, err := s.repo.GetUserByTgID(r.Context(), req.TenantID, callerTgID); err == nil && u.Role == domain.RoleAdmin {
			isAdmin = true
		}
	}
	if !isAdmin {
		writeError(w, http.StatusForbidden, "only workspace admins can change roles")
		return
	}

	if err := s.repo.SetUserRole(r.Context(), req.TenantID, req.TgID, req.Role); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "user not found in workspace")
			return
		}
		s.log.Error("set user role (miniapp)", "tenant", req.TenantID, "tg_id", req.TgID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"tg_id": req.TgID, "role": req.Role})
}

// ---------------------------------------------------------------------------
// POST /miniapp/bind-user
// ---------------------------------------------------------------------------

type miniappBindUserRequest struct {
	InitData      string `json:"init_data"`
	TenantID      string `json:"tenant_id"`
	TgID          string `json:"tg_id"`
	YougileUserID string `json:"yougile_user_id"` // empty = remove binding
}

// handleMiniAppBindUser lets a workspace admin link (or unlink) a TG user to
// a YouGile account directly from the mini-app, without requiring the user to
// go through /start themselves.
func (s *Server) handleMiniAppBindUser(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TelegramBotToken == "" {
		writeError(w, http.StatusServiceUnavailable, "mini-app: TELEGRAM_BOT_TOKEN not configured")
		return
	}

	var req miniappBindUserRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.InitData == "" || req.TenantID == "" || req.TgID == "" {
		writeError(w, http.StatusBadRequest, "init_data, tenant_id and tg_id are required")
		return
	}

	vals, err := parseTelegramInitData(req.InitData, s.cfg.TelegramBotToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid telegram data: "+err.Error())
		return
	}
	caller, err := extractTgUser(vals)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ws, err := s.repo.GetWorkspace(r.Context(), req.TenantID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace (miniapp bind-user)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	callerTgID := fmt.Sprintf("%d", caller.ID)
	isAdmin := ws.HostTgID == callerTgID
	if !isAdmin {
		if u, err := s.repo.GetUserByTgID(r.Context(), req.TenantID, callerTgID); err == nil && u.Role == domain.RoleAdmin {
			isAdmin = true
		}
	}
	if !isAdmin {
		writeError(w, http.StatusForbidden, "only workspace admins can change user bindings")
		return
	}

	if err := s.repo.SetUserYougileBinding(r.Context(), req.TenantID, req.TgID, req.YougileUserID); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "user not found in workspace")
			return
		}
		s.log.Error("set user yougile binding (miniapp)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// If a new binding was set, clean up any phantom placeholder for that YouGile user.
	if req.YougileUserID != "" {
		_ = s.repo.DeletePhantomUser(r.Context(), req.TenantID, req.YougileUserID)
	}

	writeJSON(w, http.StatusOK, map[string]string{"tg_id": req.TgID, "yougile_user_id": req.YougileUserID})
}

// ---------------------------------------------------------------------------
// POST /miniapp/update-task
// ---------------------------------------------------------------------------

type miniappUpdateTaskRequest struct {
	InitData    string  `json:"init_data"`
	TenantID    string  `json:"tenant_id"`
	TaskID      string  `json:"task_id"`
	Title       *string `json:"title,omitempty"`
	Description *string `json:"description,omitempty"`
	Status      *string `json:"status,omitempty"`
	AssigneeID  *string `json:"assignee_user_id,omitempty"`
	Deadline    *string `json:"deadline,omitempty"`
}

// handleMiniAppUpdateTask verifies Telegram identity + admin/moderator role,
// then proxies a task patch to the internal update handler.
func (s *Server) handleMiniAppUpdateTask(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TelegramBotToken == "" {
		writeError(w, http.StatusServiceUnavailable, "mini-app: TELEGRAM_BOT_TOKEN not configured")
		return
	}

	var req miniappUpdateTaskRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.InitData == "" || req.TenantID == "" || req.TaskID == "" {
		writeError(w, http.StatusBadRequest, "init_data, tenant_id and task_id are required")
		return
	}

	vals, err := parseTelegramInitData(req.InitData, s.cfg.TelegramBotToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid telegram data: "+err.Error())
		return
	}
	caller, err := extractTgUser(vals)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ws, err := s.repo.GetWorkspace(r.Context(), req.TenantID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace (miniapp update-task)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	callerTgID := fmt.Sprintf("%d", caller.ID)
	allowed := ws.HostTgID == callerTgID
	if !allowed {
		if u, err := s.repo.GetUserByTgID(r.Context(), req.TenantID, callerTgID); err == nil {
			allowed = u.Role == domain.RoleAdmin || u.Role == domain.RoleModerator
		}
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "only admins and moderators can edit tasks")
		return
	}

	task, err := s.repo.GetTask(r.Context(), req.TaskID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "task not found")
			return
		}
		s.log.Error("get task (miniapp update-task)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if task.TenantID != req.TenantID {
		writeError(w, http.StatusForbidden, "task does not belong to this workspace")
		return
	}

	oldStatus := task.Status

	if req.Title != nil {
		task.Title = *req.Title
	}
	if req.Description != nil {
		task.Description = *req.Description
	}
	if req.Status != nil {
		task.Status = *req.Status
	}
	if req.AssigneeID != nil {
		if *req.AssigneeID == "" {
			task.AssigneeUserID = nil
		} else {
			task.AssigneeUserID = req.AssigneeID
		}
	}
	if req.Deadline != nil {
		if *req.Deadline == "" {
			task.Deadline = nil
		} else {
			t, _, err := parseDeadline(*req.Deadline, time.UTC)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid deadline format (use YYYY-MM-DD)")
				return
			}
			task.Deadline = &t
		}
	}

	updated, err := s.repo.UpdateTask(r.Context(), task)
	if err != nil {
		s.log.Error("update task (miniapp)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Sync YouGile card column when status changed (best-effort).
	if req.Status != nil && *req.Status != oldStatus {
		s.syncCardStatus(r.Context(), updated, *req.Status)
	}

	// Sync title/description/deadline/assignee changes to YouGile (best-effort).
	fieldChanged := req.Title != nil || req.Description != nil || req.Deadline != nil || req.AssigneeID != nil
	if fieldChanged {
		s.syncCardFields(r.Context(), updated, updateTaskRequest{
			Title:          req.Title,
			Description:    req.Description,
			AssigneeUserID: req.AssigneeID,
			Deadline:       req.Deadline,
		})
	}

	writeJSON(w, http.StatusOK, updated)
}

// ---------------------------------------------------------------------------
// POST /miniapp/confirm-mode
// ---------------------------------------------------------------------------

type miniappConfirmModeRequest struct {
	InitData string `json:"init_data"`
	TenantID string `json:"tenant_id"`
	Mode     string `json:"mode"`
}

func (s *Server) handleMiniAppSetConfirmMode(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TelegramBotToken == "" {
		writeError(w, http.StatusServiceUnavailable, "mini-app: TELEGRAM_BOT_TOKEN not configured")
		return
	}

	var req miniappConfirmModeRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.InitData == "" || req.TenantID == "" {
		writeError(w, http.StatusBadRequest, "init_data and tenant_id are required")
		return
	}
	if req.Mode != "admin_only" && req.Mode != "everyone" && req.Mode != "auto" {
		writeError(w, http.StatusBadRequest, `mode must be "admin_only", "everyone" or "auto"`)
		return
	}

	vals, err := parseTelegramInitData(req.InitData, s.cfg.TelegramBotToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid telegram data: "+err.Error())
		return
	}
	caller, err := extractTgUser(vals)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ws, err := s.repo.GetWorkspace(r.Context(), req.TenantID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace (miniapp confirm-mode)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	callerTgID := fmt.Sprintf("%d", caller.ID)
	isAdmin := ws.HostTgID == callerTgID
	if !isAdmin {
		if u, err := s.repo.GetUserByTgID(r.Context(), req.TenantID, callerTgID); err == nil && u.Role == domain.RoleAdmin {
			isAdmin = true
		}
	}
	if !isAdmin {
		writeError(w, http.StatusForbidden, "only workspace admins can change confirm mode")
		return
	}

	if err := s.repo.SetConfirmMode(r.Context(), req.TenantID, req.Mode); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("set confirm mode (miniapp)", "tenant", req.TenantID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"confirm_mode": req.Mode})
}

// ---------------------------------------------------------------------------
// POST /miniapp/task-detection
// ---------------------------------------------------------------------------

type miniappTaskDetectionRequest struct {
	InitData string `json:"init_data"`
	TenantID string `json:"tenant_id"`
	Mode     string `json:"mode"`
}

func (s *Server) handleMiniAppSetTaskDetection(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TelegramBotToken == "" {
		writeError(w, http.StatusServiceUnavailable, "mini-app: TELEGRAM_BOT_TOKEN not configured")
		return
	}

	var req miniappTaskDetectionRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.InitData == "" || req.TenantID == "" {
		writeError(w, http.StatusBadRequest, "init_data and tenant_id are required")
		return
	}
	if req.Mode != "ai" && req.Mode != "heuristic" {
		writeError(w, http.StatusBadRequest, `mode must be "ai" or "heuristic"`)
		return
	}

	vals, err := parseTelegramInitData(req.InitData, s.cfg.TelegramBotToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid telegram data: "+err.Error())
		return
	}
	caller, err := extractTgUser(vals)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ws, err := s.repo.GetWorkspace(r.Context(), req.TenantID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace (miniapp task-detection)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	callerTgID := fmt.Sprintf("%d", caller.ID)
	isAdmin := ws.HostTgID == callerTgID
	if !isAdmin {
		if u, err := s.repo.GetUserByTgID(r.Context(), req.TenantID, callerTgID); err == nil && u.Role == domain.RoleAdmin {
			isAdmin = true
		}
	}
	if !isAdmin {
		writeError(w, http.StatusForbidden, "only workspace admins can change task detection")
		return
	}

	if err := s.repo.SetTaskDetection(r.Context(), req.TenantID, req.Mode); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("set task detection (miniapp)", "tenant", req.TenantID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"task_detection": req.Mode})
}

// ---------------------------------------------------------------------------
// POST /miniapp/digest
// ---------------------------------------------------------------------------

type miniappUpdateDigestRequest struct {
	InitData string `json:"init_data"`
	TenantID string `json:"tenant_id"`
	Enabled  bool   `json:"enabled"`
	Time     string `json:"time"`
}

func (s *Server) handleMiniAppUpdateDigest(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TelegramBotToken == "" {
		writeError(w, http.StatusServiceUnavailable, "mini-app: TELEGRAM_BOT_TOKEN not configured")
		return
	}

	var req miniappUpdateDigestRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.InitData == "" || req.TenantID == "" {
		writeError(w, http.StatusBadRequest, "init_data and tenant_id are required")
		return
	}

	vals, err := parseTelegramInitData(req.InitData, s.cfg.TelegramBotToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid telegram data: "+err.Error())
		return
	}
	caller, err := extractTgUser(vals)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ws, err := s.repo.GetWorkspace(r.Context(), req.TenantID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace (miniapp digest)", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	callerTgID := fmt.Sprintf("%d", caller.ID)
	isAdmin := ws.HostTgID == callerTgID
	if !isAdmin {
		if u, err := s.repo.GetUserByTgID(r.Context(), req.TenantID, callerTgID); err == nil && u.Role == domain.RoleAdmin {
			isAdmin = true
		}
	}
	if !isAdmin {
		writeError(w, http.StatusForbidden, "only workspace admins can change digest settings")
		return
	}

	digestTime := req.Time
	if digestTime == "" {
		digestTime = "09:00"
	}

	if err := s.repo.SetDigestSettings(r.Context(), req.TenantID, req.Enabled, digestTime); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("set digest settings (miniapp)", "tenant", req.TenantID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"enabled": req.Enabled, "time": digestTime})
}

// ---------------------------------------------------------------------------
// POST /miniapp/set-timezone
// ---------------------------------------------------------------------------

type miniappSetTimezoneRequest struct {
	InitData string `json:"init_data"`
	Timezone string `json:"timezone"` // IANA, e.g. "Asia/Omsk"
}

// handleMiniAppSetTimezone verifies the caller's Telegram identity and stores
// their IANA timezone across all workspaces. Called silently on mini-app load.
func (s *Server) handleMiniAppSetTimezone(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TelegramBotToken == "" {
		writeError(w, http.StatusServiceUnavailable, "mini-app: TELEGRAM_BOT_TOKEN not configured")
		return
	}

	var req miniappSetTimezoneRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.InitData == "" || req.Timezone == "" {
		writeError(w, http.StatusBadRequest, "init_data and timezone are required")
		return
	}
	if _, err := time.LoadLocation(req.Timezone); err != nil {
		writeError(w, http.StatusBadRequest, "invalid IANA timezone: "+req.Timezone)
		return
	}

	vals, err := parseTelegramInitData(req.InitData, s.cfg.TelegramBotToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid telegram data: "+err.Error())
		return
	}
	user, err := extractTgUser(vals)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	tgIDStr := fmt.Sprintf("%d", user.ID)
	if err := s.repo.UpdateUserTimezoneGlobal(r.Context(), tgIDStr, req.Timezone); err != nil {
		s.log.Error("set timezone (miniapp)", "tg_id", tgIDStr, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"tg_id": tgIDStr, "timezone": req.Timezone})
}
