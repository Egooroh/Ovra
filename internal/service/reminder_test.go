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

// --- fakeReminderStore ---

type fakeReminderStore struct {
	due        []domain.ReminderDue
	dueErr     error
	markedIDs  []string
	markErr    error
}

func (f *fakeReminderStore) ListDueReminders(_ context.Context, _ time.Duration) ([]domain.ReminderDue, error) {
	return f.due, f.dueErr
}

func (f *fakeReminderStore) MarkTaskReminded(_ context.Context, taskID string) error {
	f.markedIDs = append(f.markedIDs, taskID)
	return f.markErr
}

// --- helpers ---

func reminderTask(id, tgID string, deadline time.Time) domain.ReminderDue {
	return domain.ReminderDue{
		TaskID:           id,
		Title:            "Task " + id,
		Deadline:         deadline,
		AssigneeTgID:     tgID,
		AssigneeTimezone: "Europe/Moscow",
	}
}

// --- tests ---

func TestReminderSchedulerNoTasks(t *testing.T) {
	var called atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	store := &fakeReminderStore{}
	sched := NewReminderScheduler(store, srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	sched.Tick(context.Background())

	if called.Load() {
		t.Fatal("bot should not be called when there are no due reminders")
	}
	if len(store.markedIDs) != 0 {
		t.Fatalf("no tasks should be marked, got %v", store.markedIDs)
	}
}

func TestReminderSchedulerSendsAndMarks(t *testing.T) {
	future := time.Now().Add(2 * time.Hour)
	due := []domain.ReminderDue{
		reminderTask("t1", "tg-1", future),
		reminderTask("t2", "tg-1", future),
	}

	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	store := &fakeReminderStore{due: due}
	sched := NewReminderScheduler(store, srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	sched.Tick(context.Background())

	if gotBody["tg_id"] != "tg-1" {
		t.Fatalf("tg_id = %v, want tg-1", gotBody["tg_id"])
	}
	tasks, _ := gotBody["tasks"].([]any)
	if len(tasks) != 2 {
		t.Fatalf("tasks count = %d, want 2", len(tasks))
	}
	if len(store.markedIDs) != 2 {
		t.Fatalf("marked = %v, want [t1 t2]", store.markedIDs)
	}
}

func TestReminderSchedulerOverdueFlagged(t *testing.T) {
	past := time.Now().Add(-1 * time.Hour)

	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	store := &fakeReminderStore{due: []domain.ReminderDue{reminderTask("t1", "tg-2", past)}}
	sched := NewReminderScheduler(store, srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	sched.Tick(context.Background())

	tasks, _ := gotBody["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("tasks = %v", tasks)
	}
	item, _ := tasks[0].(map[string]any)
	if item["overdue"] != true {
		t.Fatalf("overdue = %v, want true", item["overdue"])
	}
}

func TestReminderSchedulerGroupsByAssignee(t *testing.T) {
	future := time.Now().Add(2 * time.Hour)
	due := []domain.ReminderDue{
		reminderTask("t1", "tg-A", future),
		reminderTask("t2", "tg-B", future),
		reminderTask("t3", "tg-A", future),
	}

	calls := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		tgID, _ := body["tg_id"].(string)
		calls[tgID]++
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	store := &fakeReminderStore{due: due}
	sched := NewReminderScheduler(store, srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	sched.Tick(context.Background())

	if calls["tg-A"] != 1 || calls["tg-B"] != 1 {
		t.Fatalf("calls per user = %v, want {tg-A:1 tg-B:1}", calls)
	}
	if len(store.markedIDs) != 3 {
		t.Fatalf("marked = %v, want 3 tasks", store.markedIDs)
	}
}

func TestReminderSchedulerBotErrorSkipsMarking(t *testing.T) {
	future := time.Now().Add(2 * time.Hour)
	store := &fakeReminderStore{due: []domain.ReminderDue{reminderTask("t1", "tg-1", future)}}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	sched := NewReminderScheduler(store, srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	sched.Tick(context.Background())

	if len(store.markedIDs) != 0 {
		t.Fatalf("should not mark when bot returns error, got %v", store.markedIDs)
	}
}

func TestReminderSchedulerStoreErrorSkips(t *testing.T) {
	store := &fakeReminderStore{dueErr: io.ErrUnexpectedEOF}
	var called atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	sched := NewReminderScheduler(store, srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	sched.Tick(context.Background())

	if called.Load() {
		t.Fatal("bot should not be called when store returns error")
	}
}
