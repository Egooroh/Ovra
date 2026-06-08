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
	users    []domain.User // returned by ListUsersByTenant
	similar   []domain.Task // returned by FindSimilarOpenTasks
	openTasks []domain.Task // returned by ListOpenTasks
	task      domain.Task   // returned by GetTask
	created  domain.Task
	updated  domain.Task
}

func (f *fakeStore) GetWorkspace(context.Context, string) (domain.Workspace, error) {
	return f.ws, nil
}
func (f *fakeStore) ListUsersByTenant(context.Context, string) ([]domain.User, error) {
	return f.users, nil
}
func (f *fakeStore) FindSimilarOpenTasks(context.Context, string, string, float64) ([]domain.Task, error) {
	return f.similar, nil
}
func (f *fakeStore) ListOpenTasks(context.Context, string, int) ([]domain.Task, error) {
	return f.openTasks, nil
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
	return NewTasks(store, yg, cipher, 0.4, log), cipher
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

type fakeJudge struct {
	out      []domain.Task
	err      error
	gotPool  []domain.Task
	gotTitle string
}

func (f *fakeJudge) JudgeDuplicates(_ context.Context, title, _ string, cands []domain.Task) ([]domain.Task, error) {
	f.gotTitle, f.gotPool = title, cands
	return f.out, f.err
}

func TestFindDuplicatesJudgeSupersedesShortlist(t *testing.T) {
	store := &fakeStore{
		similar:   []domain.Task{{ID: "trgm-hit"}},                                  // layer 2 shortlist
		openTasks: []domain.Task{{ID: "a", Title: "X"}, {ID: "b", Title: "Y"}},       // judge pool
	}
	svc, _ := newService(t, store, &fakeYG{})
	j := &fakeJudge{out: []domain.Task{{ID: "b"}}} // judge confirms only "b"
	svc.SetDuplicateJudge(j)

	dups, err := svc.FindDuplicates(context.Background(), "ws-1", "new", "desc")
	if err != nil {
		t.Fatalf("FindDuplicates: %v", err)
	}
	if len(dups) != 1 || dups[0].ID != "b" {
		t.Fatalf("dups = %+v, want judge verdict [b]", dups)
	}
	if len(j.gotPool) != 2 || j.gotTitle != "new" {
		t.Fatalf("judge got pool=%d title=%q", len(j.gotPool), j.gotTitle)
	}
}

func TestFindDuplicatesJudgeErrorFallsBackToShortlist(t *testing.T) {
	store := &fakeStore{
		similar:   []domain.Task{{ID: "trgm-hit"}},
		openTasks: []domain.Task{{ID: "a", Title: "X"}},
	}
	svc, _ := newService(t, store, &fakeYG{})
	svc.SetDuplicateJudge(&fakeJudge{err: errors.New("provider down")})

	dups, err := svc.FindDuplicates(context.Background(), "ws-1", "new", "")
	if err != nil {
		t.Fatalf("FindDuplicates: %v", err)
	}
	if len(dups) != 1 || dups[0].ID != "trgm-hit" {
		t.Fatalf("expected trgm fallback, got %+v", dups)
	}
}

func TestCreateAndPublishDetectsDuplicate(t *testing.T) {
	store := &fakeStore{ws: domain.Workspace{ID: "ws-1"}}
	store.similar = []domain.Task{{ID: "existing", Title: "Починить вход"}}
	svc, cipher := newService(t, store, &fakeYG{})
	enc, _ := cipher.Seal("tok")
	store.tokenEnc = enc

	_, err := svc.CreateAndPublish(context.Background(), TaskInput{
		TenantID: "ws-1", Title: "Исправить авторизацию",
	})
	var dup *DuplicateError
	if !errors.As(err, &dup) {
		t.Fatalf("err = %v, want *DuplicateError", err)
	}
	if len(dup.Candidates) != 1 || dup.Candidates[0].ID != "existing" {
		t.Fatalf("candidates = %+v", dup.Candidates)
	}
	if store.created.ID != "" {
		t.Fatal("task must not be persisted on duplicate")
	}
}

func TestCreateAndPublishForceBypassesDedup(t *testing.T) {
	store := &fakeStore{ws: domain.Workspace{ID: "ws-1"}}
	store.ws.Columns.Todo = "col-todo"
	store.similar = []domain.Task{{ID: "existing", Title: "дубль"}}
	svc, cipher := newService(t, store, &fakeYG{})
	enc, _ := cipher.Seal("tok")
	store.tokenEnc = enc

	_, err := svc.CreateAndPublish(context.Background(), TaskInput{
		TenantID: "ws-1", Title: "дубль", Force: true,
	})
	if err != nil {
		t.Fatalf("force should bypass dedup: %v", err)
	}
	if store.created.ID == "" {
		t.Fatal("task should be created when forced")
	}
}

func TestCreateAndPublishUsesRegisteredUser(t *testing.T) {
	store := &fakeStore{ws: domain.Workspace{ID: "ws-1"}}
	store.ws.Columns.Todo = "col-todo"
	// Registered member: chat name "Ваня" maps to YouGile user "yg-77".
	store.users = []domain.User{{ID: "u-int", FullName: "Ваня", YougileUserID: "yg-77"}}
	yg := &fakeYG{} // ListUsers not needed — table hit wins

	svc, cipher := newService(t, store, yg)
	enc, _ := cipher.Seal("tok")
	store.tokenEnc = enc

	_, err := svc.CreateAndPublish(context.Background(), TaskInput{
		TenantID: "ws-1", Title: "t", Assignee: "ваня",
	})
	if err != nil {
		t.Fatalf("CreateAndPublish: %v", err)
	}
	if len(yg.lastReq.Assigned) != 1 || yg.lastReq.Assigned[0] != "yg-77" {
		t.Fatalf("card assignee = %v, want yg-77", yg.lastReq.Assigned)
	}
	if store.created.AssigneeUserID == nil || *store.created.AssigneeUserID != "u-int" {
		t.Fatalf("internal assignee_user_id = %v, want u-int", store.created.AssigneeUserID)
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
