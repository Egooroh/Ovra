package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"ovra/internal/domain"
)

// Postgres is the Repository implementation backed by a pgx connection pool.
type Postgres struct {
	pool *pgxpool.Pool
}

// compile-time check that Postgres satisfies Repository.
var _ Repository = (*Postgres)(nil)

// Connect opens a pooled connection to Postgres and verifies it with a ping.
func Connect(ctx context.Context, dsn string) (*Postgres, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Postgres{pool: pool}, nil
}

// Pool exposes the underlying pool (used by the migration runner).
func (p *Postgres) Pool() *pgxpool.Pool { return p.pool }

// Close releases the pool.
func (p *Postgres) Close() { p.pool.Close() }

// --- workspaces ---

func (p *Postgres) UpsertWorkspace(ctx context.Context, ws domain.Workspace) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO workspaces
			(id, chat_id, name, yougile_project_id,
			 col_todo, col_in_progress, col_review, col_done, host_tg_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (id) DO UPDATE SET
			chat_id            = EXCLUDED.chat_id,
			name               = EXCLUDED.name,
			yougile_project_id = EXCLUDED.yougile_project_id,
			col_todo           = EXCLUDED.col_todo,
			col_in_progress    = EXCLUDED.col_in_progress,
			col_review         = EXCLUDED.col_review,
			col_done           = EXCLUDED.col_done,
			host_tg_id         = EXCLUDED.host_tg_id`,
		ws.ID, ws.ChatID, ws.Name, ws.YougileProjectID,
		ws.Columns.Todo, ws.Columns.InProgress, ws.Columns.Review, ws.Columns.Done,
		ws.HostTgID)
	if err != nil {
		return fmt.Errorf("upsert workspace: %w", err)
	}
	return nil
}

func (p *Postgres) GetWorkspace(ctx context.Context, id string) (domain.Workspace, error) {
	var ws domain.Workspace
	err := p.pool.QueryRow(ctx, `
		SELECT id, chat_id, name, yougile_project_id,
		       col_todo, col_in_progress, col_review, col_done, host_tg_id
		FROM workspaces WHERE id = $1`, id).
		Scan(&ws.ID, &ws.ChatID, &ws.Name, &ws.YougileProjectID,
			&ws.Columns.Todo, &ws.Columns.InProgress, &ws.Columns.Review, &ws.Columns.Done,
			&ws.HostTgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Workspace{}, ErrNotFound
	}
	if err != nil {
		return domain.Workspace{}, fmt.Errorf("get workspace: %w", err)
	}
	return ws, nil
}

// SetYougileCredentials stores the workspace login and the encrypted API token.
func (p *Postgres) SetYougileCredentials(ctx context.Context, tenantID, login string, tokenEnc []byte) error {
	ct, err := p.pool.Exec(ctx, `
		UPDATE workspaces
		SET yougile_login = $2, yougile_api_token_enc = $3
		WHERE id = $1`, tenantID, login, tokenEnc)
	if err != nil {
		return fmt.Errorf("set yougile credentials: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// GetYougileTokenEnc returns the stored login and encrypted token. A workspace
// with no token yet returns empty tokenEnc and nil error.
func (p *Postgres) GetYougileTokenEnc(ctx context.Context, tenantID string) (string, []byte, error) {
	var login string
	var tokenEnc []byte
	err := p.pool.QueryRow(ctx, `
		SELECT yougile_login, yougile_api_token_enc
		FROM workspaces WHERE id = $1`, tenantID).
		Scan(&login, &tokenEnc)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, ErrNotFound
	}
	if err != nil {
		return "", nil, fmt.Errorf("get yougile token: %w", err)
	}
	return login, tokenEnc, nil
}

// SetWorkspaceColumns updates only the board-column ids of a workspace.
func (p *Postgres) SetWorkspaceColumns(ctx context.Context, tenantID string, c domain.Columns) error {
	ct, err := p.pool.Exec(ctx, `
		UPDATE workspaces
		SET col_todo = $2, col_in_progress = $3, col_review = $4, col_done = $5
		WHERE id = $1`,
		tenantID, c.Todo, c.InProgress, c.Review, c.Done)
	if err != nil {
		return fmt.Errorf("set workspace columns: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// --- users ---

func (p *Postgres) UpsertUser(ctx context.Context, u domain.User) (domain.User, error) {
	err := p.pool.QueryRow(ctx, `
		INSERT INTO users (tenant_id, tg_id, tg_username, full_name, yougile_user_id)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (tenant_id, tg_id) DO UPDATE SET
			tg_username     = EXCLUDED.tg_username,
			full_name       = EXCLUDED.full_name,
			yougile_user_id = EXCLUDED.yougile_user_id
		RETURNING id`,
		u.TenantID, u.TgID, u.TgUsername, u.FullName, u.YougileUserID).
		Scan(&u.ID)
	if err != nil {
		return domain.User{}, fmt.Errorf("upsert user: %w", err)
	}
	return u, nil
}

func (p *Postgres) GetUser(ctx context.Context, id string) (domain.User, error) {
	u, err := scanUser(p.pool.QueryRow(ctx, `
		SELECT id, tenant_id, tg_id, tg_username, full_name, yougile_user_id
		FROM users WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.User{}, ErrNotFound
	}
	if err != nil {
		return domain.User{}, fmt.Errorf("get user: %w", err)
	}
	return u, nil
}

func (p *Postgres) ListUsersByTenant(ctx context.Context, tenantID string) ([]domain.User, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, tenant_id, tg_id, tg_username, full_name, yougile_user_id
		FROM users WHERE tenant_id = $1 ORDER BY full_name`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()

	var out []domain.User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// --- tasks ---

func (p *Postgres) CreateTask(ctx context.Context, t domain.Task) (domain.Task, error) {
	err := p.pool.QueryRow(ctx, `
		INSERT INTO tasks
			(tenant_id, title, description, assignee_user_id, deadline,
			 status, approval_status, yougile_task_id, meeting_id, source)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		RETURNING id, created_at, updated_at`,
		t.TenantID, t.Title, t.Description, t.AssigneeUserID, t.Deadline,
		defaultStr(t.Status, domain.StatusTodo),
		defaultStr(t.ApprovalStatus, domain.ApprovalPending),
		t.YougileTaskID, t.MeetingID,
		defaultStr(t.Source, domain.SourceChat)).
		Scan(&t.ID, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return domain.Task{}, fmt.Errorf("create task: %w", err)
	}
	// Reflect the defaults that the DB applied back onto the returned value.
	t.Status = defaultStr(t.Status, domain.StatusTodo)
	t.ApprovalStatus = defaultStr(t.ApprovalStatus, domain.ApprovalPending)
	t.Source = defaultStr(t.Source, domain.SourceChat)
	return t, nil
}

func (p *Postgres) GetTask(ctx context.Context, id string) (domain.Task, error) {
	t, err := scanTask(p.pool.QueryRow(ctx, taskSelect+` WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Task{}, ErrNotFound
	}
	if err != nil {
		return domain.Task{}, fmt.Errorf("get task: %w", err)
	}
	return t, nil
}

func (p *Postgres) UpdateTask(ctx context.Context, t domain.Task) (domain.Task, error) {
	err := p.pool.QueryRow(ctx, `
		UPDATE tasks SET
			title            = $2,
			description      = $3,
			assignee_user_id = $4,
			deadline         = $5,
			status           = $6,
			approval_status  = $7,
			yougile_task_id  = $8,
			meeting_id       = $9,
			source           = $10,
			updated_at       = now()
		WHERE id = $1
		RETURNING updated_at`,
		t.ID, t.Title, t.Description, t.AssigneeUserID, t.Deadline,
		t.Status, t.ApprovalStatus, t.YougileTaskID, t.MeetingID, t.Source).
		Scan(&t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Task{}, ErrNotFound
	}
	if err != nil {
		return domain.Task{}, fmt.Errorf("update task: %w", err)
	}
	return t, nil
}

func (p *Postgres) ListTasksByTenant(ctx context.Context, tenantID string) ([]domain.Task, error) {
	rows, err := p.pool.Query(ctx, taskSelect+`
		WHERE tenant_id = $1 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	defer rows.Close()

	var out []domain.Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("scan task: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// FindSimilarOpenTasks returns active tasks similar to title (exact-insensitive
// or pg_trgm similarity >= threshold), most similar first.
func (p *Postgres) FindSimilarOpenTasks(ctx context.Context, tenantID, title string, threshold float64) ([]domain.Task, error) {
	rows, err := p.pool.Query(ctx, taskSelect+`
		WHERE tenant_id = $1
		  AND status <> 'done'
		  AND approval_status <> 'rejected'
		  AND (lower(title) = lower($2) OR similarity(title, $2) >= $3)
		ORDER BY similarity(title, $2) DESC
		LIMIT 5`, tenantID, title, threshold)
	if err != nil {
		return nil, fmt.Errorf("find similar tasks: %w", err)
	}
	defer rows.Close()

	var out []domain.Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("scan similar task: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ListOpenTasks returns up to limit active tasks of the tenant, newest first.
func (p *Postgres) ListOpenTasks(ctx context.Context, tenantID string, limit int) ([]domain.Task, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := p.pool.Query(ctx, taskSelect+`
		WHERE tenant_id = $1 AND status <> 'done' AND approval_status <> 'rejected'
		ORDER BY created_at DESC LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, fmt.Errorf("list open tasks: %w", err)
	}
	defer rows.Close()

	var out []domain.Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("scan open task: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// --- helpers ---

// row is satisfied by both *pgx.Row (QueryRow) and pgx.Rows (Query).
type row interface {
	Scan(dest ...any) error
}

const taskSelect = `
	SELECT id, tenant_id, title, description, assignee_user_id, deadline,
	       status, approval_status, yougile_task_id, meeting_id, source,
	       created_at, updated_at
	FROM tasks`

func scanTask(r row) (domain.Task, error) {
	var t domain.Task
	err := r.Scan(&t.ID, &t.TenantID, &t.Title, &t.Description, &t.AssigneeUserID,
		&t.Deadline, &t.Status, &t.ApprovalStatus, &t.YougileTaskID, &t.MeetingID,
		&t.Source, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

func scanUser(r row) (domain.User, error) {
	var u domain.User
	err := r.Scan(&u.ID, &u.TenantID, &u.TgID, &u.TgUsername, &u.FullName, &u.YougileUserID)
	return u, err
}

// defaultStr returns def when s is empty.
func defaultStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
