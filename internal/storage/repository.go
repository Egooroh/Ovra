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

	// YouGile credentials (set during bot onboarding). The token is stored
	// encrypted; callers pass/receive ciphertext and use the secret package.
	SetYougileCredentials(ctx context.Context, tenantID, login string, tokenEnc []byte) error
	GetYougileTokenEnc(ctx context.Context, tenantID string) (login string, tokenEnc []byte, err error)

	// Users.
	UpsertUser(ctx context.Context, u domain.User) (domain.User, error)
	GetUser(ctx context.Context, id string) (domain.User, error)
	ListUsersByTenant(ctx context.Context, tenantID string) ([]domain.User, error)

	// Tasks (CRUD).
	CreateTask(ctx context.Context, t domain.Task) (domain.Task, error)
	GetTask(ctx context.Context, id string) (domain.Task, error)
	UpdateTask(ctx context.Context, t domain.Task) (domain.Task, error)
	ListTasksByTenant(ctx context.Context, tenantID string) ([]domain.Task, error)
}
