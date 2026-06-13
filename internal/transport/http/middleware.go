package http

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

// statusRecorder captures the response status code for logging.
type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.wrote = true
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if !r.wrote {
		r.status = http.StatusOK
		r.wrote = true
	}
	return r.ResponseWriter.Write(b)
}

// requireBotSecret is middleware that enforces a shared-secret token on all
// mutating /v1/* requests (POST/PATCH/DELETE). GET and /miniapp/* are exempt.
//
// Two callers authenticate with two different secrets, by design:
//   - the meeting-worker POSTs /v1/meetings/summary with WORKER_SECRET;
//   - the Telegram bot uses BOT_SECRET for every other /v1/* mutation.
//
// When the relevant secret is empty the check is skipped (dev mode).
func (s *Server) requireBotSecret(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/v1/") {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}

		// The meeting-worker authenticates to /v1/meetings/summary with
		// WORKER_SECRET; everything else is the bot with BOT_SECRET.
		expected, name := s.cfg.BotSecret, "bot secret"
		if r.URL.Path == "/v1/meetings/summary" {
			expected, name = s.cfg.WorkerSecret, "worker secret"
		}
		if expected == "" {
			next.ServeHTTP(w, r) // dev mode: no secret configured
			return
		}
		auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if auth != expected {
			writeError(w, http.StatusUnauthorized, "invalid or missing "+name)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// recoverPanic turns a handler panic into a 500 instead of crashing the server.
func (s *Server) recoverPanic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.log.Error("panic recovered",
					"method", r.Method, "path", r.URL.Path,
					"err", rec, "stack", string(debug.Stack()))
				writeError(w, http.StatusInternalServerError, "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// requestLogger logs one structured line per request: method, path, status and
// duration. The level rises with the status class (5xx → error, 4xx → warn).
func (s *Server) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(rec, r)

		s.log.Log(r.Context(), levelForStatus(rec.status), "request",
			"method", r.Method, "path", r.URL.Path,
			"status", rec.status, "dur_ms", time.Since(start).Milliseconds())
	})
}

// levelForStatus picks a log level from the HTTP status class.
func levelForStatus(status int) slog.Level {
	switch {
	case status >= 500:
		return slog.LevelError
	case status >= 400:
		return slog.LevelWarn
	default:
		return slog.LevelInfo
	}
}
