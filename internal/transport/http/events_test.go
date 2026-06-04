package http

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"testing"

	"ovra/internal/config"
	"ovra/internal/queue"
)

// fakeQueue records published events.
type fakeQueue struct {
	published []queue.Event
	err       error
}

func (f *fakeQueue) Publish(_ context.Context, e queue.Event) error {
	if f.err != nil {
		return f.err
	}
	f.published = append(f.published, e)
	return nil
}
func (f *fakeQueue) Subscribe(queue.Handler) {}
func (f *fakeQueue) Close()                  {}

func eventServer(t *testing.T, q queue.Queue) http.Handler {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewServer(&config.Config{}, nil, nil, nil, nil, q, log).Routes()
}

func TestPublishEventQueues(t *testing.T) {
	fq := &fakeQueue{}
	h := eventServer(t, fq)

	rec := post(t, h, "/v1/events",
		`{"type":"task_create","tenant_id":"ws-1","payload":{"title":"x"}}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if len(fq.published) != 1 || fq.published[0].Type != "task_create" {
		t.Fatalf("published = %+v", fq.published)
	}
}

func TestPublishEventMissingFields(t *testing.T) {
	h := eventServer(t, &fakeQueue{})
	rec := post(t, h, "/v1/events", `{"payload":{}}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestPublishEventNoQueue(t *testing.T) {
	h := eventServer(t, nil)
	rec := post(t, h, "/v1/events", `{"type":"x","tenant_id":"ws-1"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
