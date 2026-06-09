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
	return vals, nil
}

// miniappTgUser is the Telegram user embedded in initData.
type miniappTgUser struct {
	ID        int64  `json:"id"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Username  string `json:"username"`
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
	} `json:"user"`
	Workspace workspaceResponse `json:"workspace"`
	IsAdmin   bool              `json:"is_admin"`
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

	var resp miniappVerifyResponse
	resp.User.ID = user.ID
	resp.User.FirstName = user.FirstName
	resp.User.LastName = user.LastName
	resp.User.Username = user.Username
	resp.Workspace = s.workspaceResp(r.Context(), ws)
	resp.IsAdmin = ws.HostTgID == fmt.Sprintf("%d", user.ID)

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
		k, err := s.yg.ObtainKey(r.Context(), req.Login, req.Password, req.CompanyName)
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
	resp.Workspaces = make([]miniappWorkspaceItem, 0, len(list))
	for _, ws := range list {
		resp.Workspaces = append(resp.Workspaces, miniappWorkspaceItem{
			workspaceResponse: s.workspaceResp(r.Context(), ws),
			IsAdmin:           ws.HostTgID == tgID,
		})
	}

	writeJSON(w, http.StatusOK, resp)
}
