package service

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"ovra/internal/domain"
	"ovra/internal/integrations/yougile"
	"ovra/internal/secret"
)

type fakeStore struct {
	ws       domain.Workspace
	tokenEnc []byte
	task     domain.Task // returned by GetTask
	created  domain.Task
	updated  domain.Task
}

func (f *fakeStore) GetWorkspace(context.Context, string) (domain.Workspace, error) {
	return f.ws, nil
}
func (f *fakeStore) GetYougileTokenEnc(context.Context, string) (string, []byte, error) {
	return "host@x.io", f.tokenEnc, nil
}
func (f *fakeStore) CreateTask(_ context.Context, t domain.Task) (domain.Task, error) {
	t.ID = "task-1"
	f.created = t
	return t, nil
}
func (f *fakeStore) GetTask(context.Context, string) (domain.Task, error) {
	return f.task, nil
}
func (f *fakeStore) UpdateTask(_ context.Context, t domain.Task) (domain.Task, error) {
	f.updated = t
	return t, nil
}

type fakeYG struct {
	users     []yougile.User
	lastReq   yougile.CreateTaskRequest
	token     string
	movedTo   string
	completed bool
}

func (f *fakeYG) ListUsers(context.Context, string) ([]yougile.User, error) {
	return f.users, nil
}
func (f *fakeYG) CreateTask(_ context.Context, token string, req yougile.CreateTaskRequest) (string, error) {
	f.token, f.lastReq = token, req
	return "card-99", nil
}
func (f *fakeYG) MoveTask(_ context.Context, _, _, columnID string) error {
	f.movedTo = columnID
	return nil
}
func (f *fakeYG) CompleteTask(context.Context, string, string) error {
	f.completed = true
	return nil
}

func newService(t *testing.T, store Store, yg YougileAPI) (*Tasks, *secret.Cipher) {
	t.Helper()
	cipher, err := secret.New("svc-key")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewTasks(store, yg, cipher, log), cipher
}

func TestCreateAndPublishHappyPath(t *testing.T) {
	store := &fakeStore{ws: domain.Workspace{ID: "ws-1"}}
	store.ws.Columns.Todo = "col-todo"
	yg := &fakeYG{users: []yougile.User{{ID: "u7", RealName: "Иван Петров"}}}

	svc, cipher := newService(t, store, yg)
	enc, _ := cipher.Seal("yg-token")
	store.tokenEnc = enc

	task, err := svc.CreateAndPublish(context.Background(), TaskInput{
		TenantID: "ws-1",
		Title:    "Ship it",
		Assignee: "иван петров",
	})
	if err != nil {
		t.Fatalf("CreateAndPublish: %v", err)
	}

	// Persisted as approved + todo.
	if store.created.ApprovalStatus != domain.ApprovalApproved || store.created.Status != domain.StatusTodo {
		t.Fatalf("persisted task = %+v", store.created)
	}
	// YouGile call used the decrypted token, right column and mapped assignee.
	if yg.token != "yg-token" {
		t.Fatalf("token passed = %q", yg.token)
	}
	if yg.lastReq.ColumnID != "col-todo" {
		t.Fatalf("columnId = %q", yg.lastReq.ColumnID)
	}
	if len(yg.lastReq.Assigned) != 1 || yg.lastReq.Assigned[0] != "u7" {
		t.Fatalf("assigned = %v", yg.lastReq.Assigned)
	}
	// yougile_task_id saved back.
	if task.YougileTaskID == nil || *task.YougileTaskID != "card-99" {
		t.Fatalf("yougile_task_id = %v", task.YougileTaskID)
	}
	if store.updated.YougileTaskID == nil || *store.updated.YougileTaskID != "card-99" {
		t.Fatalf("update not persisted: %+v", store.updated)
	}
}

func TestCreateAndPublishNoCredentials(t *testing.T) {
	store := &fakeStore{ws: domain.Workspace{ID: "ws-1"}} // tokenEnc nil
	svc, _ := newService(t, store, &fakeYG{})

	_, err := svc.CreateAndPublish(context.Background(), TaskInput{TenantID: "ws-1", Title: "x"})
	if !errors.Is(err, ErrNoCredentials) {
		t.Fatalf("err = %v, want ErrNoCredentials", err)
	}
}

func TestUpdateStatusMovesAndCompletes(t *testing.T) {
	cardID := "card-7"
	store := &fakeStore{
		ws:   domain.Workspace{ID: "ws-1"},
		task: domain.Task{ID: "t1", TenantID: "ws-1", YougileTaskID: &cardID},
	}
	store.ws.Columns.Done = "col-done"
	yg := &fakeYG{}
	svc, cipher := newService(t, store, yg)
	enc, _ := cipher.Seal("tok")
	store.tokenEnc = enc

	task, err := svc.UpdateStatus(context.Background(), "t1", domain.StatusDone)
	if err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	if task.Status != domain.StatusDone || store.updated.Status != domain.StatusDone {
		t.Fatalf("status not persisted: %+v", store.updated)
	}
	if yg.movedTo != "col-done" {
		t.Fatalf("moved to %q, want col-done", yg.movedTo)
	}
	if !yg.completed {
		t.Fatal("expected CompleteTask on done")
	}
}

func TestUpdateStatusInvalid(t *testing.T) {
	svc, _ := newService(t, &fakeStore{}, &fakeYG{})
	_, err := svc.UpdateStatus(context.Background(), "t1", "bogus")
	if !errors.Is(err, ErrInvalidStatus) {
		t.Fatalf("err = %v, want ErrInvalidStatus", err)
	}
}

func TestUpdateStatusUnpublishedSkipsYouGile(t *testing.T) {
	// No YougileTaskID → DB updated, no card move attempted.
	store := &fakeStore{task: domain.Task{ID: "t1", TenantID: "ws-1"}}
	yg := &fakeYG{}
	svc, _ := newService(t, store, yg)

	_, err := svc.UpdateStatus(context.Background(), "t1", domain.StatusInProgress)
	if err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	if yg.movedTo != "" || yg.completed {
		t.Fatalf("YouGile should not be called: movedTo=%q completed=%v", yg.movedTo, yg.completed)
	}
}

func TestCreateAndPublishUnknownAssignee(t *testing.T) {
	store := &fakeStore{ws: domain.Workspace{ID: "ws-1"}}
	store.ws.Columns.Todo = "col-todo"
	yg := &fakeYG{users: []yougile.User{{ID: "u7", RealName: "Иван"}}}
	svc, cipher := newService(t, store, yg)
	enc, _ := cipher.Seal("tok")
	store.tokenEnc = enc

	_, err := svc.CreateAndPublish(context.Background(), TaskInput{
		TenantID: "ws-1", Title: "t", Assignee: "Кто-то Неизвестный",
	})
	if err != nil {
		t.Fatalf("should not fail on unknown assignee: %v", err)
	}
	if len(yg.lastReq.Assigned) != 0 {
		t.Fatalf("expected unassigned card, got %v", yg.lastReq.Assigned)
	}
}
