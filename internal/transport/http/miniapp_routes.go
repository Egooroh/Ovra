package http

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"ovra/internal/domain"
	"ovra/internal/storage"
)

// registerAppRoutes mounts the Mini App: a Telegram-authenticated JSON API under
// /app/api/* and the static SPA bundle under /app/*. Every API route is gated by
// requireTelegramAuth (verified initData) plus a role check (host or member).
func (s *Server) registerAppRoutes(mux *http.ServeMux) {
	// Bootstrap: who am I, which workspace, what role, what state.
	mux.HandleFunc("GET /app/api/me", s.appAuth(s.handleAppMe))

	// Join flow — any verified Telegram user who has the workspace's signed link.
	mux.HandleFunc("GET /app/api/workspaces/{tenant}/yougile-users", s.appAuth(s.requireKnownTenant(s.handleYouGileUsers)))
	mux.HandleFunc("POST /app/api/workspaces/{tenant}/join", s.appAuth(s.requireKnownTenant(s.handleAppJoin)))

	// Member-visible reads.
	mux.HandleFunc("GET /app/api/workspaces/{tenant}", s.appAuth(s.requireMember(s.handleGetWorkspace)))
	mux.HandleFunc("GET /app/api/workspaces/{tenant}/tasks", s.appAuth(s.requireMember(s.handleListTasks)))
	mux.HandleFunc("GET /app/api/workspaces/{tenant}/digest", s.appAuth(s.requireMember(s.handleGetDigest)))

	// Host-only administration.
	mux.HandleFunc("GET /app/api/workspaces/{tenant}/yougile-projects", s.appAuth(s.requireHost(s.handleYouGileProjects)))
	mux.HandleFunc("POST /app/api/workspaces/{tenant}/credentials", s.appAuth(s.requireHost(s.handleSetCredentials)))
	mux.HandleFunc("POST /app/api/workspaces/{tenant}/project", s.appAuth(s.requireHost(s.handleSetProject)))
	mux.HandleFunc("POST /app/api/workspaces/{tenant}/board/resolve", s.appAuth(s.requireHost(s.handleResolveBoard)))
	mux.HandleFunc("PATCH /app/api/workspaces/{tenant}/digest", s.appAuth(s.requireHost(s.handleUpdateDigestSettings)))
	mux.HandleFunc("GET /app/api/workspaces/{tenant}/calendar/accounts", s.appAuth(s.requireHost(s.handleListCalendarAccounts)))
	mux.HandleFunc("POST /app/api/workspaces/{tenant}/calendar/accounts", s.appAuth(s.requireHost(s.handleCreateCalendarAccount)))
	mux.HandleFunc("DELETE /app/api/workspaces/{tenant}/calendar/accounts/{id}", s.appAuth(s.requireHost(s.handleDeleteCalendarAccount)))

	// Static SPA bundle (lowest precedence — only matches what the API didn't).
	mux.HandleFunc("GET /app/", s.serveMiniApp)
	mux.HandleFunc("GET /app", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/app/", http.StatusFound)
	})
}

// appAuth applies requireTelegramAuth to a HandlerFunc.
func (s *Server) appAuth(next http.HandlerFunc) http.HandlerFunc {
	return s.requireTelegramAuth(next).ServeHTTP
}

// appMeResponse is the bootstrap payload the SPA loads on launch.
type appMeResponse struct {
	TgID      string `json:"tg_id"`
	Username  string `json:"username"`
	FirstName string `json:"first_name"`

	TenantID      string `json:"tenant_id"`
	WorkspaceName string `json:"workspace_name"`
	Role          string `json:"role"` // "host" | "member" | "guest"
	Connected     bool   `json:"connected"`
	BoardResolved bool   `json:"board_resolved"`
	Linked        bool   `json:"linked"` // caller is bound to a YouGile user
}

// handleAppMe returns the caller's identity and the workspace named by the
// signed start_param, plus the caller's role and onboarding state.
func (s *Server) handleAppMe(w http.ResponseWriter, r *http.Request) {
	id, _ := identityFrom(r.Context())
	resp := appMeResponse{
		TgID:      itoa(id.TgID),
		Username:  id.Username,
		FirstName: id.FirstName,
		Role:      "guest",
	}

	tenant := id.StartParam
	if tenant == "" {
		writeJSON(w, http.StatusOK, resp) // launched without a workspace context
		return
	}

	ws, err := s.repo.GetWorkspace(r.Context(), tenant)
	if err != nil {
		writeJSON(w, http.StatusOK, resp) // unknown tenant → treat as guest
		return
	}
	resp.TenantID = ws.ID
	resp.WorkspaceName = ws.Name
	resp.BoardResolved = ws.Columns.Todo != ""
	if _, enc, err := s.repo.GetYougileTokenEnc(r.Context(), ws.ID); err == nil && len(enc) > 0 {
		resp.Connected = true
	}

	if ws.HostTgID == itoa(id.TgID) {
		resp.Role = "host"
	}
	users, err := s.repo.ListUsersByTenant(r.Context(), ws.ID)
	if err == nil {
		for _, u := range users {
			if u.TgID == itoa(id.TgID) {
				if resp.Role == "guest" {
					resp.Role = "member"
				}
				resp.Linked = u.YougileUserID != ""
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// appJoinRequest binds the caller to a YouGile user. tg_id is NOT taken from the
// body — it comes from the verified initData, so nobody can register as another.
type appJoinRequest struct {
	YougileUserID string `json:"yougile_user_id"`
	FullName      string `json:"full_name"`
}

// handleAppJoin registers the verified caller as a workspace member bound to the
// chosen YouGile user. The host keeps their host role; others become members.
func (s *Server) handleAppJoin(w http.ResponseWriter, r *http.Request) {
	id, _ := identityFrom(r.Context())
	tenant := r.PathValue("tenant")

	var req appJoinRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ws, err := s.repo.GetWorkspace(r.Context(), tenant)
	if err != nil {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}

	fullName := strings.TrimSpace(req.FullName)
	if fullName == "" {
		fullName = strings.TrimSpace(id.FirstName + " " + id.LastName)
	}
	if fullName == "" {
		fullName = id.Username
	}

	role := domain.RoleMember
	if ws.HostTgID == itoa(id.TgID) {
		role = domain.RoleAdmin
	}

	username := ""
	if id.Username != "" {
		username = "@" + id.Username
	}

	u, err := s.repo.UpsertUser(r.Context(), domain.User{
		TenantID:      tenant,
		TgID:          itoa(id.TgID),
		TgUsername:    username,
		FullName:      fullName,
		YougileUserID: req.YougileUserID,
		Role:          role,
	})
	if err != nil {
		s.log.Error("app join: upsert user", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, toUserResponse(u))
}

// requireKnownTenant gates the join flow: a valid initData and an existing
// workspace are enough (the caller is not yet a member). The signed start link
// is the shared secret that grants the right to join.
func (s *Server) requireKnownTenant(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := identityFrom(r.Context()); !ok {
			writeError(w, http.StatusUnauthorized, "missing Telegram auth")
			return
		}
		if _, err := s.repo.GetWorkspace(r.Context(), r.PathValue("tenant")); err != nil {
			if errors.Is(err, storage.ErrNotFound) {
				writeError(w, http.StatusNotFound, "workspace not found")
				return
			}
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		next(w, r)
	}
}

// serveMiniApp serves the built SPA from cfg.MiniAppDir, falling back to
// index.html for client-side routes. Path traversal is blocked by resolving
// against the bundle root and verifying the cleaned path stays inside it.
func (s *Server) serveMiniApp(w http.ResponseWriter, r *http.Request) {
	root := s.cfg.MiniAppDir
	if root == "" {
		http.NotFound(w, r)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, "/app/")
	if rel == "" {
		rel = "index.html"
	}
	clean := filepath.Clean(rel)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		http.NotFound(w, r)
		return
	}
	full := filepath.Join(root, clean)
	if info, err := os.Stat(full); err != nil || info.IsDir() {
		full = filepath.Join(root, "index.html") // SPA fallback
	}
	http.ServeFile(w, r, full)
}
