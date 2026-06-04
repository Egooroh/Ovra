// Package queue is the messaging seam between the API gateway and the worker.
// The in-memory implementation uses Go channels; swapping it for NATS JetStream
// later means a new Queue implementation, not a rewrite of producers/consumers.
package queue

import (
	"context"
	"encoding/json"
)

// Event is the unit passed through the queue. Payload is type-specific and
// decoded by the handler that owns the type.
type Event struct {
	Type     string          `json:"type"`
	TenantID string          `json:"tenant_id"`
	Payload  json.RawMessage `json:"payload"`
}

// Handler consumes one event. A returned error is logged; there is no retry in
// the MVP implementation.
type Handler func(ctx context.Context, e Event) error

// Queue publishes and delivers events.
type Queue interface {
	// Publish enqueues an event; it returns ctx.Err() if ctx is cancelled.
	Publish(ctx context.Context, e Event) error
	// Subscribe registers the handler that receives events. Call once.
	Subscribe(h Handler)
	// Close stops delivery and waits for the consumer to finish.
	Close()
}
