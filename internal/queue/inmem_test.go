package queue

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestPublishDeliversToSubscriber(t *testing.T) {
	q := NewInMemory(8, testLog())

	var mu sync.Mutex
	var got []string
	done := make(chan struct{}, 3)
	q.Subscribe(func(_ context.Context, e Event) error {
		mu.Lock()
		got = append(got, e.Type)
		mu.Unlock()
		done <- struct{}{}
		return nil
	})

	for _, ty := range []string{"a", "b", "c"} {
		if err := q.Publish(context.Background(), Event{Type: ty, TenantID: "ws"}); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}
	for i := 0; i < 3; i++ {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for delivery")
		}
	}
	q.Close()

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 3 {
		t.Fatalf("delivered %d events, want 3", len(got))
	}
}

func TestPublishAfterCloseFails(t *testing.T) {
	q := NewInMemory(1, testLog())
	q.Subscribe(func(context.Context, Event) error { return nil })
	q.Close()

	err := q.Publish(context.Background(), Event{Type: "x", TenantID: "ws"})
	if err != ErrClosed {
		t.Fatalf("err = %v, want ErrClosed", err)
	}
}

func TestPublishRespectsContext(t *testing.T) {
	// Buffer of 1, no subscriber: second publish blocks until ctx cancels.
	q := NewInMemory(1, testLog())
	if err := q.Publish(context.Background(), Event{Type: "a", TenantID: "ws"}); err != nil {
		t.Fatalf("first publish: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := q.Publish(ctx, Event{Type: "b", TenantID: "ws"}); err != context.DeadlineExceeded {
		t.Fatalf("err = %v, want DeadlineExceeded", err)
	}
}
