// Package worker consumes queue events and routes them to per-type handlers.
// It is the consumer side of the queue seam; today it runs as one goroutine,
// later it can become a pool without touching the handlers.
package worker

import (
	"context"
	"log/slog"

	"ovra/internal/queue"
)

// Router dispatches events to handlers registered per event type.
type Router struct {
	handlers map[string]queue.Handler
	log      *slog.Logger
}

// NewRouter creates an empty router.
func NewRouter(log *slog.Logger) *Router {
	return &Router{handlers: make(map[string]queue.Handler), log: log}
}

// Register binds a handler to an event type.
func (r *Router) Register(eventType string, h queue.Handler) {
	r.handlers[eventType] = h
}

// Handle routes an event to its handler. Unknown types are logged and ignored
// (not an error) so an unrecognised producer can't crash the consumer.
func (r *Router) Handle(ctx context.Context, e queue.Event) error {
	h, ok := r.handlers[e.Type]
	if !ok {
		r.log.Warn("no handler for event type", "type", e.Type, "tenant", e.TenantID)
		return nil
	}
	return h(ctx, e)
}
