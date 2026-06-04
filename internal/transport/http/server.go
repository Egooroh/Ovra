// Package http is the API gateway: routing, handlers and request validation.
// Phase 0 wires only GET /healthz; the /v1/* handlers land in Phase 3 (B-07).
package http

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"ovra/internal/config"
	"ovra/internal/domain"
	"ovra/internal/integrations/yougile"
	"ovra/internal/queue"
	"ovra/internal/secret"
	"ovra/internal/service"
	"ovra/internal/storage"
)

// TaskService is the task application logic the handlers depend on.
// *service.Tasks implements it; the interface keeps handlers testable.
type TaskService interface {
	CreateAndPublish(ctx context.Context, in service.TaskInput) (domain.Task, error)
	UpdateStatus(ctx context.Context, id, status string) (domain.Task, error)
}

// Server holds the dependencies the HTTP handlers need.
type Server struct {
	cfg    *config.Config
	repo   storage.Repository
	cipher *secret.Cipher
	yg     *yougile.Client
	tasks  TaskService
	queue  queue.Queue
	log    *slog.Logger
}

// NewServer builds a Server with its dependencies. repo, cipher, tasks and queue
// may be nil until fully wired (cipher/tasks require APP_SECRET).
func NewServer(cfg *config.Config, repo storage.Repository, cipher *secret.Cipher, yg *yougile.Client, tasks TaskService, q queue.Queue, log *slog.Logger) *Server {
	return &Server{cfg: cfg, repo: repo, cipher: cipher, yg: yg, tasks: tasks, queue: q, log: log}
}

// Routes returns the configured HTTP handler (Go 1.22+ method-aware mux).
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("POST /v1/workspaces/{tenant}/credentials", s.handleSetCredentials)
	mux.HandleFunc("POST /v1/tasks", s.handleCreateTask)
	mux.HandleFunc("PATCH /v1/tasks/{id}", s.handleUpdateTask)
	mux.HandleFunc("GET /v1/workspaces/{tenant}/tasks", s.handleListTasks)
	mux.HandleFunc("POST /v1/events", s.handlePublishEvent)
	// Outermost first: recover panics, then log every request.
	return s.recoverPanic(s.requestLogger(mux))
}

// handleHealthz reports liveness and how many tenants are loaded.
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":     "ok",
		"workspaces": len(s.cfg.Workspaces),
	})
}

// writeJSON writes v as a JSON response with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError writes a JSON error envelope: {"error": "..."}.
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
