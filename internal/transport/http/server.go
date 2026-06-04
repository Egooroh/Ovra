// Package http is the API gateway: routing, handlers and request validation.
// Phase 0 wires only GET /healthz; the /v1/* handlers land in Phase 3 (B-07).
package http

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"ovra/internal/config"
)

// Server holds the dependencies the HTTP handlers need.
type Server struct {
	cfg *config.Config
	log *slog.Logger
}

// NewServer builds a Server with its dependencies.
func NewServer(cfg *config.Config, log *slog.Logger) *Server {
	return &Server{cfg: cfg, log: log}
}

// Routes returns the configured HTTP handler (Go 1.22+ method-aware mux).
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	return s.withLogging(mux)
}

// handleHealthz reports liveness and how many tenants are loaded.
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":     "ok",
		"workspaces": len(s.cfg.Workspaces),
	})
}

// withLogging logs one line per request at debug level.
func (s *Server) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.log.Debug("request", "method", r.Method, "path", r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

// writeJSON writes v as a JSON response with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
