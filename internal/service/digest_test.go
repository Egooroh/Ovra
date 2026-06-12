package service

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"ovra/internal/domain"
)

// --- fakeDigestStore ---

type fakeDigestStore struct {
	workspaces []domain.Workspace
	err        error
}

func (f *fakeDigestStore) ListWorkspaces(_ context.Context) ([]domain.Workspace, error) {
	return f.workspaces, f.err
}

// --- helpers ---

func workspaceAt(id, chatID, tz, digestTime string, enabled bool) domain.Workspace {
	return domain.Workspace{
		ID:            id,
		ChatID:        chatID,
		Timezone:      tz,
		DigestEnabled: enabled,
		DigestTime:    digestTime,
	}
}

// nowHHMM returns "HH:MM" for the current time in the given location.
func nowHHMM(loc *time.Location) string {
	return time.Now().In(loc).Format("15:04")
}

// --- tests ---

func TestDigestSchedulerFiresOnTime(t *testing.T) {
	moscowLoc, _ := time.LoadLocation("Europe/Moscow")
	hhmm := nowHHMM(moscowLoc)

	ws := workspaceAt("ws-1", "-100", "Europe/Moscow", hhmm, true)

	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	store := &fakeDigestStore{workspaces: []domain.Workspace{ws}}
	sched := NewDigestScheduler(store, srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	sched.Tick(context.Background())

	if gotBody["tenant_id"] != "ws-1" || gotBody["chat_id"] != "-100" {
		t.Fatalf("body = %v", gotBody)
	}
}

func TestDigestSchedulerDoesNotFireWrongTime(t *testing.T) {
	var called atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	ws := workspaceAt("ws-1", "-100", "Europe/Moscow", "03:47", true)
	store := &fakeDigestStore{workspaces: []domain.Workspace{ws}}
	sched := NewDigestScheduler(store, srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	sched.Tick(context.Background())

	if called.Load() {
		t.Fatal("digest should not fire at wrong time")
	}
}

func TestDigestSchedulerDoesNotFireWhenDisabled(t *testing.T) {
	moscowLoc, _ := time.LoadLocation("Europe/Moscow")
	hhmm := nowHHMM(moscowLoc)

	var called atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	ws := workspaceAt("ws-1", "-100", "Europe/Moscow", hhmm, false) // disabled
	store := &fakeDigestStore{workspaces: []domain.Workspace{ws}}
	sched := NewDigestScheduler(store, srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	sched.Tick(context.Background())

	if called.Load() {
		t.Fatal("digest should not fire when disabled")
	}
}

func TestDigestSchedulerDoesNotFireWithoutChatID(t *testing.T) {
	moscowLoc, _ := time.LoadLocation("Europe/Moscow")
	hhmm := nowHHMM(moscowLoc)

	var called atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	ws := workspaceAt("ws-1", "", "Europe/Moscow", hhmm, true) // no chatID
	store := &fakeDigestStore{workspaces: []domain.Workspace{ws}}
	sched := NewDigestScheduler(store, srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	sched.Tick(context.Background())

	if called.Load() {
		t.Fatal("digest should not fire without chat_id")
	}
}

func TestDigestSchedulerDeduplicatesWithinDay(t *testing.T) {
	moscowLoc, _ := time.LoadLocation("Europe/Moscow")
	hhmm := nowHHMM(moscowLoc)

	var count atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	ws := workspaceAt("ws-1", "-100", "Europe/Moscow", hhmm, true)
	store := &fakeDigestStore{workspaces: []domain.Workspace{ws}}
	sched := NewDigestScheduler(store, srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))

	sched.Tick(context.Background())
	sched.Tick(context.Background()) // second tick in the same minute
	sched.Tick(context.Background())

	if count.Load() != 1 {
		t.Fatalf("digest fired %d times, want exactly 1 per day", count.Load())
	}
}

func TestDigestSchedulerStoreErrorSkips(t *testing.T) {
	var called atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	store := &fakeDigestStore{err: io.ErrUnexpectedEOF}
	sched := NewDigestScheduler(store, srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	sched.Tick(context.Background())

	if called.Load() {
		t.Fatal("bot should not be called when store returns error")
	}
}

func TestDigestLocationFallback(t *testing.T) {
	loc := digestLocation("")
	if loc == nil {
		t.Fatal("should return non-nil location for empty tz")
	}
	loc2 := digestLocation("Invalid/Zone")
	if loc2 != time.UTC {
		t.Fatalf("invalid tz should fall back to UTC, got %v", loc2)
	}
}
