package http

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"ovra/internal/config"
	"ovra/internal/domain"
	"ovra/internal/service"
	"ovra/internal/storage"
)

// fakePublisher is a stand-in for *service.Tasks.
type fakePublisher struct {
	in   service.TaskInput
	task domain.Task
	err  error
}

func (f *fakePublisher) CreateAndPublish(_ context.Context, in service.TaskInput) (domain.Task, error) {
	f.in = in
	return f.task, f.err
}

func taskServer(t *testing.T, pub TaskPublisher) http.Handler {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewServer(&config.Config{}, nil, nil, nil, pub, log).Routes()
}

func TestCreateTaskSuccess(t *testing.T) {
	cardID := "card-1"
	pub := &fakePublisher{task: domain.Task{
		ID: "t1", TenantID: "ws-1", Title: "Do X",
		Status: domain.StatusTodo, ApprovalStatus: domain.ApprovalApproved,
		Source: domain.SourceChat, YougileTaskID: &cardID,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}}
	h := taskServer(t, pub)

	rec := post(t, h, "/v1/tasks",
		`{"tenant_id":"ws-1","title":"Do X","assignee":"Иван","deadline":"2026-06-10T18:00:00Z"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// Input forwarded to the service, including parsed deadline.
	if pub.in.TenantID != "ws-1" || pub.in.Assignee != "Иван" {
		t.Fatalf("forwarded input = %+v", pub.in)
	}
	if pub.in.Deadline == nil || pub.in.Deadline.UTC().Format(time.RFC3339) != "2026-06-10T18:00:00Z" {
		t.Fatalf("deadline = %v", pub.in.Deadline)
	}
	var resp taskResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ID != "t1" || resp.YougileTaskID == nil || *resp.YougileTaskID != "card-1" {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestCreateTaskMissingFields(t *testing.T) {
	h := taskServer(t, &fakePublisher{})
	rec := post(t, h, "/v1/tasks", `{"title":"no tenant"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestCreateTaskBadDeadline(t *testing.T) {
	h := taskServer(t, &fakePublisher{})
	rec := post(t, h, "/v1/tasks", `{"tenant_id":"ws-1","title":"x","deadline":"10 June"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestCreateTaskNoCredentials(t *testing.T) {
	h := taskServer(t, &fakePublisher{err: service.ErrNoCredentials})
	rec := post(t, h, "/v1/tasks", `{"tenant_id":"ws-1","title":"x"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}

func TestCreateTaskUnknownWorkspace(t *testing.T) {
	h := taskServer(t, &fakePublisher{err: storage.ErrNotFound})
	rec := post(t, h, "/v1/tasks", `{"tenant_id":"ghost","title":"x"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestCreateTaskPersistedButCardFailed(t *testing.T) {
	// Task has an ID (persisted) but publishing errored → 502 with the task.
	pub := &fakePublisher{
		task: domain.Task{ID: "t9", TenantID: "ws-1", Title: "x", CreatedAt: time.Now(), UpdatedAt: time.Now()},
		err:  io.ErrUnexpectedEOF,
	}
	h := taskServer(t, pub)
	rec := post(t, h, "/v1/tasks", `{"tenant_id":"ws-1","title":"x"}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "t9") {
		t.Fatalf("expected task in body, got %s", rec.Body.String())
	}
}

func TestCreateTaskDisabledWithoutPublisher(t *testing.T) {
	h := taskServer(t, nil)
	rec := post(t, h, "/v1/tasks", `{"tenant_id":"ws-1","title":"x"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
