package worker

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"

	"ovra/internal/domain"
	"ovra/internal/queue"
	"ovra/internal/service"
)

func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestRouterDispatchesByType(t *testing.T) {
	r := NewRouter(testLog())
	var hit string
	r.Register("a", func(context.Context, queue.Event) error { hit = "a"; return nil })
	r.Register("b", func(context.Context, queue.Event) error { hit = "b"; return nil })

	if err := r.Handle(context.Background(), queue.Event{Type: "b"}); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if hit != "b" {
		t.Fatalf("dispatched to %q, want b", hit)
	}
}

func TestRouterUnknownTypeIsNoError(t *testing.T) {
	r := NewRouter(testLog())
	if err := r.Handle(context.Background(), queue.Event{Type: "unknown"}); err != nil {
		t.Fatalf("unknown type should be ignored, got %v", err)
	}
}

// fakeCreator records the TaskInput passed to CreateAndPublish.
type fakeCreator struct{ in service.TaskInput }

func (f *fakeCreator) CreateAndPublish(_ context.Context, in service.TaskInput) (domain.Task, error) {
	f.in = in
	return domain.Task{ID: "t1"}, nil
}

func TestTaskCreateHandlerParsesPayload(t *testing.T) {
	fc := &fakeCreator{}
	h := TaskCreateHandler(fc)

	payload, _ := json.Marshal(map[string]string{
		"title":    "Сделать дело",
		"assignee": "Иван",
		"deadline": "2026-06-10T18:00:00Z",
	})
	err := h(context.Background(), queue.Event{
		Type: EventTaskCreate, TenantID: "ws-1", Payload: payload,
	})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if fc.in.TenantID != "ws-1" || fc.in.Title != "Сделать дело" || fc.in.Assignee != "Иван" {
		t.Fatalf("parsed input = %+v", fc.in)
	}
	if fc.in.Deadline == nil {
		t.Fatal("deadline not parsed")
	}
}

func TestTaskCreateHandlerRequiresTitle(t *testing.T) {
	h := TaskCreateHandler(&fakeCreator{})
	err := h(context.Background(), queue.Event{
		Type: EventTaskCreate, TenantID: "ws-1", Payload: json.RawMessage(`{}`),
	})
	if err == nil {
		t.Fatal("expected error for missing title")
	}
}
