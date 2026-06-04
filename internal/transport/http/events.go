package http

import (
	"errors"
	"net/http"

	"ovra/internal/queue"
)

// handlePublishEvent accepts a raw event and enqueues it. This is the ingress
// for the bot (У3) and the meeting worker (У2); the worker consumes the queue
// and routes by type.
func (s *Server) handlePublishEvent(w http.ResponseWriter, r *http.Request) {
	if s.queue == nil {
		writeError(w, http.StatusServiceUnavailable, "event queue unavailable")
		return
	}

	var e queue.Event
	if err := decodeJSON(w, r, &e); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if e.Type == "" || e.TenantID == "" {
		writeError(w, http.StatusBadRequest, "type and tenant_id are required")
		return
	}

	if err := s.queue.Publish(r.Context(), e); err != nil {
		if errors.Is(err, queue.ErrClosed) {
			writeError(w, http.StatusServiceUnavailable, "server shutting down")
			return
		}
		s.log.Error("publish event", "type", e.Type, "tenant", e.TenantID, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Accepted for async processing.
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "queued"})
}
