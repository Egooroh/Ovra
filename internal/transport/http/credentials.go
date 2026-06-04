package http

import (
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
		k, err := s.yg.ObtainKey(r.Context(), req.Login, req.Password, req.CompanyName)
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
