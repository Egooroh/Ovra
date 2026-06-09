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
			 col_todo, col_in_progress, col_review, col_done, host_tg_id, timezone,
			 digest_enabled, digest_time)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE(NULLIF($10,''),'Europe/Moscow'),$11,COALESCE(NULLIF($12,''),'09:00'))
		ON CONFLICT (id) DO UPDATE SET
			chat_id            = EXCLUDED.chat_id,
			name               = EXCLUDED.name,
			yougile_project_id = EXCLUDED.yougile_project_id,
			col_todo           = EXCLUDED.col_todo,
			col_in_progress    = EXCLUDED.col_in_progress,
			col_review         = EXCLUDED.col_review,
			col_done           = EXCLUDED.col_done,
			host_tg_id         = EXCLUDED.host_tg_id,
			timezone           = EXCLUDED.timezone`,
		ws.ID, ws.ChatID, ws.Name, ws.YougileProjectID,
		ws.Columns.Todo, ws.Columns.InProgress, ws.Columns.Review, ws.Columns.Done,
		ws.HostTgID, ws.Timezone, ws.DigestEnabled, ws.DigestTime)
	if err != nil {
		return fmt.Errorf("upsert workspace: %w", err)
	}
	return nil
}

func (p *Postgres) GetWorkspace(ctx context.Context, id string) (domain.Workspace, error) {
	var ws domain.Workspace
	err := p.pool.QueryRow(ctx, `
		SELECT id, chat_id, name, yougile_project_id,
		       col_todo, col_in_progress, col_review, col_done, host_tg_id, timezone,
		       digest_enabled, digest_time
		FROM workspaces WHERE id = $1`, id).
		Scan(&ws.ID, &ws.ChatID, &ws.Name, &ws.YougileProjectID,
			&ws.Columns.Todo, &ws.Columns.InProgress, &ws.Columns.Review, &ws.Columns.Done,
			&ws.HostTgID, &ws.Timezone, &ws.DigestEnabled, &ws.DigestTime)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Workspace{}, ErrNotFound
	}
	if err != nil {
		return domain.Workspace{}, fmt.Errorf("get workspace: %w", err)
	}
	return ws, nil
}

// GetWorkspaceByChat resolves a workspace by its Telegram chat id.
func (p *Postgres) GetWorkspaceByChat(ctx context.Context, chatID string) (domain.Workspace, error) {
	var ws domain.Workspace
	err := p.pool.QueryRow(ctx, `
		SELECT id, chat_id, name, yougile_project_id,
		       col_todo, col_in_progress, col_review, col_done, host_tg_id, timezone,
		       digest_enabled, digest_time
		FROM workspaces WHERE chat_id = $1 LIMIT 1`, chatID).
		Scan(&ws.ID, &ws.ChatID, &ws.Name, &ws.YougileProjectID,
			&ws.Columns.Todo, &ws.Columns.InProgress, &ws.Columns.Review, &ws.Columns.Done,
			&ws.HostTgID, &ws.Timezone, &ws.DigestEnabled, &ws.DigestTime)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Workspace{}, ErrNotFound
	}
	if err != nil {
		return domain.Workspace{}, fmt.Errorf("get workspace by chat: %w", err)
	}
	return ws, nil
}

// ListWorkspacesForTgUser returns workspaces where tgID is the host or a
// registered member, ordered by name. Powers the Mini App "my boards" screen.
func (p *Postgres) ListWorkspacesForTgUser(ctx context.Context, tgID string) ([]domain.Workspace, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT DISTINCT w.id, w.chat_id, w.name, w.yougile_project_id,
		       w.col_todo, w.col_in_progress, w.col_review, w.col_done,
		       w.host_tg_id, w.timezone
		FROM workspaces w
		LEFT JOIN users u ON u.tenant_id = w.id
		WHERE w.host_tg_id = $1 OR u.tg_id = $1
		ORDER BY w.name`, tgID)
	if err != nil {
		return nil, fmt.Errorf("list workspaces for tg user: %w", err)
	}
	defer rows.Close()

	var out []domain.Workspace
	for rows.Next() {
		var ws domain.Workspace
		if err := rows.Scan(&ws.ID, &ws.ChatID, &ws.Name, &ws.YougileProjectID,
			&ws.Columns.Todo, &ws.Columns.InProgress, &ws.Columns.Review, &ws.Columns.Done,
			&ws.HostTgID, &ws.Timezone); err != nil {
			return nil, fmt.Errorf("scan workspace: %w", err)
		}
		out = append(out, ws)
	}
	return out, rows.Err()
}

// ListWorkspaces returns all workspaces that have YouGile credentials configured
// (yougile_api_token_enc IS NOT NULL) — used by the auto-sync background job.
func (p *Postgres) ListWorkspaces(ctx context.Context) ([]domain.Workspace, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, chat_id, name, yougile_project_id,
		       col_todo, col_in_progress, col_review, col_done, host_tg_id, timezone,
		       digest_enabled, digest_time
		FROM workspaces
		WHERE yougile_api_token_enc IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}
	defer rows.Close()
	var out []domain.Workspace
	for rows.Next() {
		var ws domain.Workspace
		if err := rows.Scan(&ws.ID, &ws.ChatID, &ws.Name, &ws.YougileProjectID,
			&ws.Columns.Todo, &ws.Columns.InProgress, &ws.Columns.Review, &ws.Columns.Done,
			&ws.HostTgID, &ws.Timezone, &ws.DigestEnabled, &ws.DigestTime); err != nil {
			return nil, fmt.Errorf("scan workspace: %w", err)
		}
		out = append(out, ws)
	}
	return out, rows.Err()
}

// SetDigestSettings updates the digest enabled flag and schedule time for a workspace.
func (p *Postgres) SetDigestSettings(ctx context.Context, tenantID string, enabled bool, digestTime string) error {
	ct, err := p.pool.Exec(ctx,
		`UPDATE workspaces SET digest_enabled = $2, digest_time = $3 WHERE id = $1`,
		tenantID, enabled, digestTime)
	if err != nil {
		return fmt.Errorf("set digest settings: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
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

// SetWorkspaceProject sets the YouGile project a workspace maps to.
func (p *Postgres) SetWorkspaceProject(ctx context.Context, tenantID, projectID string) error {
	ct, err := p.pool.Exec(ctx,
		`UPDATE workspaces SET yougile_project_id = $2 WHERE id = $1`, tenantID, projectID)
	if err != nil {
		return fmt.Errorf("set workspace project: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// --- users ---

func (p *Postgres) UpsertUser(ctx context.Context, u domain.User) (domain.User, error) {
	role := u.Role
	if role == "" {
		role = domain.RoleMember
	}
	err := p.pool.QueryRow(ctx, `
		INSERT INTO users (tenant_id, tg_id, tg_username, full_name, yougile_user_id, role)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (tenant_id, tg_id) DO UPDATE SET
			tg_username     = EXCLUDED.tg_username,
			full_name       = EXCLUDED.full_name,
			yougile_user_id = EXCLUDED.yougile_user_id,
			role            = EXCLUDED.role
		RETURNING id`,
		u.TenantID, u.TgID, u.TgUsername, u.FullName, u.YougileUserID, role).
		Scan(&u.ID)
	if err != nil {
		return domain.User{}, fmt.Errorf("upsert user: %w", err)
	}
	u.Role = role
	return u, nil
}

func (p *Postgres) GetUser(ctx context.Context, id string) (domain.User, error) {
	u, err := scanUser(p.pool.QueryRow(ctx, `
		SELECT id, tenant_id, tg_id, tg_username, full_name, yougile_user_id, role
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
		SELECT id, tenant_id, tg_id, tg_username, full_name, yougile_user_id, role
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
		WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, tenantID)
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
		  AND deleted_at IS NULL
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
		WHERE tenant_id = $1
		  AND status <> 'done'
		  AND approval_status <> 'rejected'
		  AND deleted_at IS NULL
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

// ListDigestTasks returns approved, non-done, non-deleted tasks of the tenant
// ordered by deadline asc (nulls last) then created_at asc.
func (p *Postgres) ListDigestTasks(ctx context.Context, tenantID string) ([]domain.Task, error) {
	rows, err := p.pool.Query(ctx, taskSelect+`
		WHERE tenant_id = $1
		  AND approval_status = 'approved'
		  AND status <> 'done'
		  AND deleted_at IS NULL
		ORDER BY deadline ASC NULLS LAST, created_at ASC`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("list digest tasks: %w", err)
	}
	defer rows.Close()

	var out []domain.Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("scan digest task: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// SoftDeleteTask moves a task to the trash (sets deleted_at = now()).
// Returns ErrNotFound if the task does not exist or is already deleted.
func (p *Postgres) SoftDeleteTask(ctx context.Context, id string) (domain.Task, error) {
	t, err := scanTask(p.pool.QueryRow(ctx, taskSelect+`
		WHERE id = $1 AND deleted_at IS NULL`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Task{}, ErrNotFound
	}
	if err != nil {
		return domain.Task{}, fmt.Errorf("soft delete task (fetch): %w", err)
	}

	now := time.Now()
	_, err = p.pool.Exec(ctx,
		`UPDATE tasks SET deleted_at = $2, updated_at = $2 WHERE id = $1`, id, now)
	if err != nil {
		return domain.Task{}, fmt.Errorf("soft delete task (update): %w", err)
	}
	t.DeletedAt = &now
	t.UpdatedAt = now
	return t, nil
}

// ListTrashTasks returns tasks in the trash (deleted_at IS NOT NULL) for the
// given tenant, ordered by deleted_at descending (newest first).
func (p *Postgres) ListTrashTasks(ctx context.Context, tenantID string) ([]domain.Task, error) {
	rows, err := p.pool.Query(ctx, taskSelect+`
		WHERE tenant_id = $1
		  AND deleted_at IS NOT NULL
		ORDER BY deleted_at DESC`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("list trash tasks: %w", err)
	}
	defer rows.Close()
	var out []domain.Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("scan trash task: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ClearTrash immediately removes all trashed tasks for the given tenant.
func (p *Postgres) ClearTrash(ctx context.Context, tenantID string) (int64, error) {
	ct, err := p.pool.Exec(ctx,
		`DELETE FROM tasks WHERE tenant_id = $1 AND deleted_at IS NOT NULL`, tenantID)
	if err != nil {
		return 0, fmt.Errorf("clear trash: %w", err)
	}
	return ct.RowsAffected(), nil
}

// DeleteExpiredTasks physically removes tasks that have been in the trash for
// more than 24 h. Returns the number of rows deleted.
func (p *Postgres) DeleteExpiredTasks(ctx context.Context) (int64, error) {
	ct, err := p.pool.Exec(ctx,
		`DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < now() - INTERVAL '24 hours'`)
	if err != nil {
		return 0, fmt.Errorf("delete expired tasks: %w", err)
	}
	return ct.RowsAffected(), nil
}

// --- helpers ---

// row is satisfied by both *pgx.Row (QueryRow) and pgx.Rows (Query).
type row interface {
	Scan(dest ...any) error
}

const taskSelect = `
	SELECT id, tenant_id, title, description, assignee_user_id, deadline,
	       status, approval_status, yougile_task_id, meeting_id, source,
	       created_at, updated_at, deleted_at
	FROM tasks`

func scanTask(r row) (domain.Task, error) {
	var t domain.Task
	err := r.Scan(&t.ID, &t.TenantID, &t.Title, &t.Description, &t.AssigneeUserID,
		&t.Deadline, &t.Status, &t.ApprovalStatus, &t.YougileTaskID, &t.MeetingID,
		&t.Source, &t.CreatedAt, &t.UpdatedAt, &t.DeletedAt)
	return t, err
}

func scanUser(r row) (domain.User, error) {
	var u domain.User
	err := r.Scan(&u.ID, &u.TenantID, &u.TgID, &u.TgUsername, &u.FullName, &u.YougileUserID, &u.Role)
	return u, err
}

// defaultStr returns def when s is empty.
func defaultStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
