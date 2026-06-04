package queue

import (
	"context"
	"errors"
	"log/slog"
	"sync"
)

// ErrClosed is returned by Publish after the queue has been closed.
var ErrClosed = errors.New("queue: closed")

// InMemory is a channel-backed Queue with a single consumer goroutine.
type InMemory struct {
	ch      chan Event
	closed  chan struct{}
	closeMu sync.Once
	wg      sync.WaitGroup
	log     *slog.Logger
}

// compile-time check.
var _ Queue = (*InMemory)(nil)

// NewInMemory creates a queue with the given buffer size.
func NewInMemory(buffer int, log *slog.Logger) *InMemory {
	if buffer <= 0 {
		buffer = 256
	}
	return &InMemory{
		ch:     make(chan Event, buffer),
		closed: make(chan struct{}),
		log:    log,
	}
}

// Publish enqueues an event, blocking only until buffer space frees up.
func (q *InMemory) Publish(ctx context.Context, e Event) error {
	select {
	case <-q.closed:
		return ErrClosed
	default:
	}
	select {
	case q.ch <- e:
		return nil
	case <-q.closed:
		return ErrClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Subscribe starts the single consumer goroutine. Call once before publishing.
func (q *InMemory) Subscribe(h Handler) {
	q.wg.Add(1)
	go func() {
		defer q.wg.Done()
		for {
			select {
			case e := <-q.ch:
				q.dispatch(h, e)
			case <-q.closed:
				q.drain(h) // process whatever is already buffered, then stop
				return
			}
		}
	}()
}

// dispatch runs the handler and logs any error.
func (q *InMemory) dispatch(h Handler, e Event) {
	if err := h(context.Background(), e); err != nil {
		q.log.Error("event handler failed", "type", e.Type, "tenant", e.TenantID, "err", err)
	}
}

// drain processes any buffered events without blocking, then returns.
func (q *InMemory) drain(h Handler) {
	for {
		select {
		case e := <-q.ch:
			q.dispatch(h, e)
		default:
			return
		}
	}
}

// Close signals shutdown and waits for the consumer to drain and exit. The
// channel is never closed, so an in-flight Publish can't panic.
func (q *InMemory) Close() {
	q.closeMu.Do(func() { close(q.closed) })
	q.wg.Wait()
}
