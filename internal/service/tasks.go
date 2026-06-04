// Package service holds the application logic that ties storage and external
// integrations together. Tasks publishes an approved task to YouGile: it
// decrypts the workspace token, maps the assignee, creates the card and saves
// the resulting yougile_task_id.
package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"ovra/internal/domain"
	"ovra/internal/integrations/yougile"
	"ovra/internal/secret"
)

// ErrNoCredentials means the workspace has not been connected to YouGile yet.
var ErrNoCredentials = errors.New("service: workspace has no YouGile credentials")

// Store is the slice of the repository the task service needs.
type Store interface {
	GetWorkspace(ctx context.Context, id string) (domain.Workspace, error)
	GetYougileTokenEnc(ctx context.Context, id string) (login string, tokenEnc []byte, err error)
	CreateTask(ctx context.Context, t domain.Task) (domain.Task, error)
	UpdateTask(ctx context.Context, t domain.Task) (domain.Task, error)
}

// YougileAPI is the slice of the YouGile client the task service needs.
type YougileAPI interface {
	ListUsers(ctx context.Context, token string) ([]yougile.User, error)
	CreateTask(ctx context.Context, token string, req yougile.CreateTaskRequest) (string, error)
}

// Tasks publishes approved tasks to YouGile.
type Tasks struct {
	store  Store
	yg     YougileAPI
	cipher *secret.Cipher
	log    *slog.Logger
}

// NewTasks builds the task service. cipher is required (it decrypts the token).
func NewTasks(store Store, yg YougileAPI, cipher *secret.Cipher, log *slog.Logger) *Tasks {
	return &Tasks{store: store, yg: yg, cipher: cipher, log: log}
}

// TaskInput is the data a task is created from (typically produced by Claude
// and approved by the host).
type TaskInput struct {
	TenantID    string
	Title       string
	Description string
	Assignee    string // human name; mapped to a YouGile user id
	Deadline    *time.Time
	Source      string // chat | meeting
}

// CreateAndPublish persists the task as approved, creates the YouGile card and
// stores its id. The task is persisted even if the card creation fails, so the
// caller can retry publishing without losing the task; the error is returned.
func (s *Tasks) CreateAndPublish(ctx context.Context, in TaskInput) (domain.Task, error) {
	if in.TenantID == "" || in.Title == "" {
		return domain.Task{}, errors.New("service: tenant_id and title are required")
	}

	ws, err := s.store.GetWorkspace(ctx, in.TenantID)
	if err != nil {
		return domain.Task{}, fmt.Errorf("get workspace: %w", err)
	}

	token, err := s.workspaceToken(ctx, in.TenantID)
	if err != nil {
		return domain.Task{}, err
	}

	// Persist first so the task survives a later YouGile failure.
	task, err := s.store.CreateTask(ctx, domain.Task{
		TenantID:       in.TenantID,
		Title:          in.Title,
		Description:    in.Description,
		Deadline:       in.Deadline,
		Status:         domain.StatusTodo,
		ApprovalStatus: domain.ApprovalApproved,
		Source:         orDefault(in.Source, domain.SourceChat),
	})
	if err != nil {
		return domain.Task{}, fmt.Errorf("create task: %w", err)
	}

	req := yougile.CreateTaskRequest{
		Title:       in.Title,
		ColumnID:    ws.Columns.Todo,
		Description: in.Description,
		Assigned:    s.resolveAssignee(ctx, token, in.Assignee),
	}
	if in.Deadline != nil {
		req.Deadline = yougile.DeadlineFromTime(*in.Deadline)
	}

	cardID, err := s.yg.CreateTask(ctx, token, req)
	if err != nil {
		// Task is persisted; report the publish failure for retry.
		return task, fmt.Errorf("create yougile card: %w", err)
	}

	task.YougileTaskID = &cardID
	task, err = s.store.UpdateTask(ctx, task)
	if err != nil {
		return task, fmt.Errorf("save yougile_task_id: %w", err)
	}

	s.log.Info("task published",
		"task_id", task.ID, "yougile_task_id", cardID, "tenant", in.TenantID)
	return task, nil
}

// workspaceToken loads and decrypts the per-workspace YouGile token.
func (s *Tasks) workspaceToken(ctx context.Context, tenantID string) (string, error) {
	_, enc, err := s.store.GetYougileTokenEnc(ctx, tenantID)
	if err != nil {
		return "", fmt.Errorf("get token: %w", err)
	}
	if len(enc) == 0 {
		return "", ErrNoCredentials
	}
	token, err := s.cipher.Open(enc)
	if err != nil {
		return "", fmt.Errorf("decrypt token: %w", err)
	}
	return token, nil
}

// resolveAssignee maps a human name to a YouGile user id. A missing assignee or
// an unmatched name is not fatal — the card is created unassigned.
func (s *Tasks) resolveAssignee(ctx context.Context, token, name string) []string {
	if name == "" {
		return nil
	}
	users, err := s.yg.ListUsers(ctx, token)
	if err != nil {
		s.log.Warn("list users for assignee", "assignee", name, "err", err)
		return nil
	}
	u, ok := yougile.FindUserByName(users, name)
	if !ok {
		s.log.Warn("assignee not found in yougile", "assignee", name)
		return nil
	}
	return []string{u.ID}
}

// orDefault returns def when s is empty.
func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
