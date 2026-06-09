// Package storage defines the Repository abstraction and its Postgres
// implementation. The interface is the "seam" that lets the rest of the app
// stay ignorant of the database (Postgres now, SQLite as an emergency fallback).
package storage

import (
	"context"
	"errors"

	"ovra/internal/domain"
)

// ErrNotFound is returned when a lookup matches no row.
var ErrNotFound = errors.New("storage: not found")

// Repository is the data-access seam used by handlers and the worker.
type Repository interface {
	// Workspaces (read + seed from config).
	UpsertWorkspace(ctx context.Context, ws domain.Workspace) error
	GetWorkspace(ctx context.Context, id string) (domain.Workspace, error)
	GetWorkspaceByChat(ctx context.Context, chatID string) (domain.Workspace, error)
	ListWorkspaces(ctx context.Context) ([]domain.Workspace, error)
	SetWorkspaceColumns(ctx context.Context, tenantID string, c domain.Columns) error
	SetWorkspaceProject(ctx context.Context, tenantID, projectID string) error

	// YouGile credentials (set during bot onboarding). The token is stored
	// encrypted; callers pass/receive ciphertext and use the secret package.
	SetYougileCredentials(ctx context.Context, tenantID, login string, tokenEnc []byte) error
	GetYougileTokenEnc(ctx context.Context, tenantID string) (login string, tokenEnc []byte, err error)

	// Workspace digest settings.
	SetDigestSettings(ctx context.Context, tenantID string, enabled bool, digestTime string) error

	// Users.
	UpsertUser(ctx context.Context, u domain.User) (domain.User, error)
	GetUser(ctx context.Context, id string) (domain.User, error)
	ListUsersByTenant(ctx context.Context, tenantID string) ([]domain.User, error)

	// Tasks (CRUD).
	CreateTask(ctx context.Context, t domain.Task) (domain.Task, error)
	GetTask(ctx context.Context, id string) (domain.Task, error)
	UpdateTask(ctx context.Context, t domain.Task) (domain.Task, error)
	ListTasksByTenant(ctx context.Context, tenantID string) ([]domain.Task, error)
	// FindSimilarOpenTasks returns active (not done/rejected/deleted) tasks of the
	// tenant whose title equals (case-insensitive) or is trigram-similar to
	// title at >= threshold. Used for deduplication.
	FindSimilarOpenTasks(ctx context.Context, tenantID, title string, threshold float64) ([]domain.Task, error)
	// ListOpenTasks returns up to limit active (not done/rejected/deleted) tasks of
	// the tenant, newest first — the candidate pool for the semantic dedup judge.
	ListOpenTasks(ctx context.Context, tenantID string, limit int) ([]domain.Task, error)
	// ListDigestTasks returns approved, non-done, non-deleted tasks of the tenant
	// ordered by deadline (nulls last) then created_at — used for the daily digest.
	ListDigestTasks(ctx context.Context, tenantID string) ([]domain.Task, error)
	// SoftDeleteTask marks a task as deleted (moves it to trash). It is physically
	// removed after 24 h by DeleteExpiredTasks.
	SoftDeleteTask(ctx context.Context, id string) (domain.Task, error)
	// ListTrashTasks returns tasks currently in the trash (deleted_at IS NOT NULL)
	// for the given tenant, ordered newest first.
	ListTrashTasks(ctx context.Context, tenantID string) ([]domain.Task, error)
	// ClearTrash immediately removes all trashed tasks for the tenant.
	// Returns the number of rows deleted.
	ClearTrash(ctx context.Context, tenantID string) (int64, error)
	// DeleteExpiredTasks physically removes tasks that have been in the trash for
	// more than 24 h. Returns the number of rows deleted.
	DeleteExpiredTasks(ctx context.Context) (int64, error)
}
