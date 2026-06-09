package http

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"ovra/internal/integrations/yougile"
	"ovra/internal/storage"
)

// credentialsRequest is the body of POST /v1/workspaces/{tenant}/credentials.
// The bot sends either a ready api_key, or login/password for the backend to
// generate one. company_name is optional and only used to disambiguate when an
// account belongs to several YouGile companies.
type credentialsRequest struct {
	APIKey      string `json:"api_key"`
	Login       string `json:"login"`
	Password    string `json:"password"`
	CompanyID   string `json:"company_id"`
	CompanyName string `json:"company_name"`
}

// handleSetCredentials stores per-workspace YouGile credentials. The password
// (if given) is used once to obtain a key and never persisted; only the key is
// stored, encrypted at rest.
func (s *Server) handleSetCredentials(w http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenant")

	if s.cipher == nil {
		writeError(w, http.StatusServiceUnavailable, "credential storage disabled: APP_SECRET not set")
		return
	}

	var req credentialsRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.APIKey == "" && (req.Login == "" || req.Password == "") {
		writeError(w, http.StatusBadRequest, "provide either api_key, or login and password")
		return
	}

	// Tenant must exist before we attach credentials to it.
	if _, err := s.repo.GetWorkspace(r.Context(), tenant); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Resolve the API key: use the supplied one, or generate via login/password.
	key := req.APIKey
	if key == "" {
		k, err := s.obtainYougileKey(r.Context(), req.Login, req.Password, req.CompanyID, req.CompanyName)
		if err != nil {
			var apiErr *yougile.APIError
			if errors.As(err, &apiErr) {
				writeError(w, http.StatusBadGateway, "yougile rejected credentials: "+apiErr.Error())
				return
			}
			s.log.Error("obtain yougile key", "tenant", tenant, "err", err)
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		key = k
	}

	// Validate the key against YouGile before storing — reject obviously bad
	// keys so the admin gets immediate feedback instead of a later 502.
	if _, err := s.yg.ListProjects(r.Context(), key); err != nil {
		var apiErr *yougile.APIError
		if errors.As(err, &apiErr) && (apiErr.Status == http.StatusUnauthorized || apiErr.Status == http.StatusForbidden) {
			writeError(w, http.StatusBadRequest, "YouGile отклонил ключ (неверный или нет доступа)")
			return
		}
		// Transient/network error — log and store anyway (the key may be valid).
		s.log.Warn("validate yougile key", "tenant", tenant, "err", err)
	}

	enc, err := s.cipher.Seal(key)
	if err != nil {
		s.log.Error("seal token", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if err := s.repo.SetYougileCredentials(r.Context(), tenant, req.Login, enc); err != nil {
		s.log.Error("store credentials", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	s.log.Info("yougile credentials stored", "tenant", tenant, "via", credentialSource(req))
	writeJSON(w, http.StatusOK, map[string]string{"status": "stored"})
}

// credentialSource reports how the key was obtained, for logging.
func credentialSource(req credentialsRequest) string {
	if req.APIKey != "" {
		return "api_key"
	}
	return "login_password"
}

// obtainYougileKey resolves an API key via login/password, preferring an explicit
// companyID; otherwise it disambiguates by companyName (or uses the sole company).
// Shared by the bot-facing and Mini App credential handlers.
func (s *Server) obtainYougileKey(ctx context.Context, login, password, companyID, companyName string) (string, error) {
	if companyID != "" {
		return s.yg.CreateKey(ctx, login, password, companyID)
	}
	return s.yg.ObtainKey(ctx, login, password, companyName)
}

// companiesView maps YouGile companies to the wire format used by the bot/mini-app.
func companiesView(companies []yougile.Company) []map[string]any {
	out := make([]map[string]any, len(companies))
	for i, c := range companies {
		out[i] = map[string]any{"id": c.ID, "name": c.Name, "is_admin": c.IsAdmin}
	}
	return out
}

// companiesRequest is the body of POST /v1/workspaces/{tenant}/yougile-companies.
type companiesRequest struct {
	Login    string `json:"login"`
	Password string `json:"password"`
}

// handleYouGileCompanies lists the YouGile companies reachable with the supplied
// login/password so the admin can pick which one to generate a key for. The
// password is used once and never stored.
func (s *Server) handleYouGileCompanies(w http.ResponseWriter, r *http.Request) {
	if s.yg == nil {
		writeError(w, http.StatusServiceUnavailable, "disabled: YouGile client not configured")
		return
	}
	tenant := r.PathValue("tenant")
	if _, err := s.repo.GetWorkspace(r.Context(), tenant); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace (companies)", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	var req companiesRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Login == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "login and password are required")
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

// decodeJSON strictly decodes a JSON request body with a size limit.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	return nil
}
