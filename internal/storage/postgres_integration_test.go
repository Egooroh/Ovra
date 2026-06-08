package storage_test

import (
	"context"
	"os"
	"testing"

	"ovra/internal/domain"
	"ovra/internal/secret"
	"ovra/internal/storage"
	"ovra/migrations"
)

// dsn returns the test database DSN, defaulting to the docker-compose Postgres
// published on host port 5433.
func dsn() string {
	if v := os.Getenv("OVRA_TEST_DSN"); v != "" {
		return v
	}
	return "postgres://ovra:ovra@localhost:5433/ovra?sslmode=disable"
}

// repo connects to Postgres and applies migrations, or skips when unreachable.
func repo(t *testing.T) *storage.Postgres {
	t.Helper()
	ctx := context.Background()
	p, err := storage.Connect(ctx, dsn())
	if err != nil {
		t.Skipf("postgres unavailable, skipping: %v", err)
	}
	t.Cleanup(p.Close)
	if err := storage.Migrate(ctx, p.Pool(), migrations.FS); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return p
}

func TestCredentialRoundTrip(t *testing.T) {
	ctx := context.Background()
	p := repo(t)

	const tenant = "test-cred-ws"
	if err := p.UpsertWorkspace(ctx, domain.Workspace{ID: tenant, ChatID: "c", Name: "Cred WS"}); err != nil {
		t.Fatalf("upsert workspace: %v", err)
	}
	t.Cleanup(func() {
		_, _ = p.Pool().Exec(ctx, `DELETE FROM workspaces WHERE id=$1`, tenant)
	})

	cipher, err := secret.New("integration-key")
	if err != nil {
		t.Fatal(err)
	}
	const token = "yg-live-token-XYZ"
	enc, err := cipher.Seal(token)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}

	if err := p.SetYougileCredentials(ctx, tenant, "host@example.com", enc); err != nil {
		t.Fatalf("set credentials: %v", err)
	}

	login, gotEnc, err := p.GetYougileTokenEnc(ctx, tenant)
	if err != nil {
		t.Fatalf("get token: %v", err)
	}
	if login != "host@example.com" {
		t.Fatalf("login = %q", login)
	}
	dec, err := cipher.Open(gotEnc)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if dec != token {
		t.Fatalf("decrypted = %q, want %q", dec, token)
	}
}

func TestFindSimilarOpenTasks(t *testing.T) {
	ctx := context.Background()
	p := repo(t)

	const tenant = "test-dedup-ws"
	if err := p.UpsertWorkspace(ctx, domain.Workspace{ID: tenant, ChatID: "c", Name: "Dedup"}); err != nil {
		t.Fatalf("upsert workspace: %v", err)
	}
	t.Cleanup(func() { _, _ = p.Pool().Exec(ctx, `DELETE FROM workspaces WHERE id=$1`, tenant) })

	if _, err := p.CreateTask(ctx, domain.Task{TenantID: tenant, Title: "Поправить баг авторизации"}); err != nil {
		t.Fatalf("create task: %v", err)
	}

	// Layer 1: exact, case-insensitive.
	got, err := p.FindSimilarOpenTasks(ctx, tenant, "поправить баг авторизации", 0.3)
	if err != nil {
		t.Fatalf("find similar: %v", err)
	}
	if len(got) == 0 {
		t.Fatal("expected case-insensitive match")
	}

	// A clearly different title must not match.
	none, err := p.FindSimilarOpenTasks(ctx, tenant, "Подготовить квартальный отчёт по продажам", 0.3)
	if err != nil {
		t.Fatalf("find similar: %v", err)
	}
	if len(none) != 0 {
		t.Fatalf("expected no match, got %d", len(none))
	}

	// Done tasks are excluded.
	dt, _ := p.CreateTask(ctx, domain.Task{TenantID: tenant, Title: "Закрытая штука"})
	dt.Status = domain.StatusDone
	if _, err := p.UpdateTask(ctx, dt); err != nil {
		t.Fatalf("update task: %v", err)
	}
	doneRes, _ := p.FindSimilarOpenTasks(ctx, tenant, "Закрытая штука", 0.3)
	if len(doneRes) != 0 {
		t.Fatalf("done task should be excluded, got %d", len(doneRes))
	}
}

func TestTaskCRUD(t *testing.T) {
	ctx := context.Background()
	p := repo(t)

	const tenant = "test-task-ws"
	if err := p.UpsertWorkspace(ctx, domain.Workspace{ID: tenant, ChatID: "c", Name: "Task WS"}); err != nil {
		t.Fatalf("upsert workspace: %v", err)
	}
	t.Cleanup(func() {
		_, _ = p.Pool().Exec(ctx, `DELETE FROM workspaces WHERE id=$1`, tenant)
	})

	created, err := p.CreateTask(ctx, domain.Task{TenantID: tenant, Title: "Write integration test"})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if created.ID == "" || created.Status != domain.StatusTodo || created.ApprovalStatus != domain.ApprovalPending {
		t.Fatalf("unexpected defaults: %+v", created)
	}

	created.ApprovalStatus = domain.ApprovalApproved
	created.Status = domain.StatusInProgress
	updated, err := p.UpdateTask(ctx, created)
	if err != nil {
		t.Fatalf("update task: %v", err)
	}
	if !updated.UpdatedAt.After(created.CreatedAt) && !updated.UpdatedAt.Equal(created.CreatedAt) {
		t.Fatalf("updated_at not advanced")
	}

	got, err := p.GetTask(ctx, created.ID)
	if err != nil {
		t.Fatalf("get task: %v", err)
	}
	if got.ApprovalStatus != domain.ApprovalApproved || got.Status != domain.StatusInProgress {
		t.Fatalf("update not persisted: %+v", got)
	}

	list, err := p.ListTasksByTenant(ctx, tenant)
	if err != nil {
		t.Fatalf("list tasks: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}
}
