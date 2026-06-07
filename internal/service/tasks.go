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
	"strings"
	"time"

	"ovra/internal/domain"
	"ovra/internal/integrations/yougile"
	"ovra/internal/secret"
)

// ErrNoCredentials means the workspace has not been connected to YouGile yet.
var ErrNoCredentials = errors.New("service: workspace has no YouGile credentials")

// ErrInvalidStatus is returned when a status is not one of the board states.
var ErrInvalidStatus = errors.New("service: invalid status")

// Store is the slice of the repository the task service needs.
type Store interface {
	GetWorkspace(ctx context.Context, id string) (domain.Workspace, error)
	GetYougileTokenEnc(ctx context.Context, id string) (login string, tokenEnc []byte, err error)
	ListUsersByTenant(ctx context.Context, tenantID string) ([]domain.User, error)
	CreateTask(ctx context.Context, t domain.Task) (domain.Task, error)
	GetTask(ctx context.Context, id string) (domain.Task, error)
	UpdateTask(ctx context.Context, t domain.Task) (domain.Task, error)
}

// YougileAPI is the slice of the YouGile client the task service needs.
type YougileAPI interface {
	ListUsers(ctx context.Context, token string) ([]yougile.User, error)
	CreateTask(ctx context.Context, token string, req yougile.CreateTaskRequest) (string, error)
	MoveTask(ctx context.Context, token, id, columnID string) error
	CompleteTask(ctx context.Context, token, id string) error
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

	// Resolve the assignee before persisting so we can record the internal
	// assignee_user_id and the YouGile assignment together.
	assigned, assigneeUserID := s.resolveAssignee(ctx, token, in.TenantID, in.Assignee)

	// Persist first so the task survives a later YouGile failure.
	task, err := s.store.CreateTask(ctx, domain.Task{
		TenantID:       in.TenantID,
		Title:          in.Title,
		Description:    in.Description,
		AssigneeUserID: assigneeUserID,
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
		Assigned:    assigned,
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

// UpdateStatus changes a task's status and moves its YouGile card to the
// matching column (completing it when done). The DB is updated first; if the
// card has not been published yet the YouGile step is skipped. A card-move
// failure leaves the DB updated and returns the task plus the error.
func (s *Tasks) UpdateStatus(ctx context.Context, id, status string) (domain.Task, error) {
	if !validStatus(status) {
		return domain.Task{}, fmt.Errorf("%w: %q", ErrInvalidStatus, status)
	}

	task, err := s.store.GetTask(ctx, id)
	if err != nil {
		return domain.Task{}, fmt.Errorf("get task: %w", err)
	}

	task.Status = status
	task, err = s.store.UpdateTask(ctx, task)
	if err != nil {
		return domain.Task{}, fmt.Errorf("update task: %w", err)
	}

	// Nothing to move if the card hasn't been published.
	if task.YougileTaskID == nil || *task.YougileTaskID == "" {
		return task, nil
	}

	ws, err := s.store.GetWorkspace(ctx, task.TenantID)
	if err != nil {
		return task, fmt.Errorf("get workspace: %w", err)
	}
	token, err := s.workspaceToken(ctx, task.TenantID)
	if err != nil {
		return task, err
	}

	if col := columnForStatus(ws, status); col != "" {
		if err := s.yg.MoveTask(ctx, token, *task.YougileTaskID, col); err != nil {
			return task, fmt.Errorf("move card: %w", err)
		}
	}
	if status == domain.StatusDone {
		if err := s.yg.CompleteTask(ctx, token, *task.YougileTaskID); err != nil {
			return task, fmt.Errorf("complete card: %w", err)
		}
	}

	s.log.Info("task status updated", "task_id", task.ID, "status", status)
	return task, nil
}

// validStatus reports whether status is a known board state.
func validStatus(status string) bool {
	switch status {
	case domain.StatusTodo, domain.StatusInProgress, domain.StatusReview, domain.StatusDone:
		return true
	default:
		return false
	}
}

// columnForStatus maps a board status to the workspace's YouGile column id.
func columnForStatus(ws domain.Workspace, status string) string {
	switch status {
	case domain.StatusTodo:
		return ws.Columns.Todo
	case domain.StatusInProgress:
		return ws.Columns.InProgress
	case domain.StatusReview:
		return ws.Columns.Review
	case domain.StatusDone:
		return ws.Columns.Done
	default:
		return ""
	}
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

// resolveAssignee maps an assignee name to (YouGile user ids for the card,
// internal assignee_user_id for the DB). It prefers the registered users table
// (TG ↔ name ↔ YouGile), falling back to matching YouGile members by name.
// A missing or unmatched assignee is not fatal — the card is created unassigned.
func (s *Tasks) resolveAssignee(ctx context.Context, token, tenantID, name string) ([]string, *string) {
	if name == "" {
		return nil, nil
	}
	want := strings.ToLower(strings.TrimSpace(name))

	// 1) Registered users table.
	if users, err := s.store.ListUsersByTenant(ctx, tenantID); err != nil {
		s.log.Warn("list registered users", "err", err)
	} else {
		for _, u := range users {
			if strings.ToLower(u.FullName) == want ||
				strings.ToLower(strings.TrimPrefix(u.TgUsername, "@")) == want {
				id := u.ID
				if u.YougileUserID != "" {
					return []string{u.YougileUserID}, &id
				}
				// Known person, but not yet mapped to YouGile — record the
				// internal assignee and try matching the card by name below.
				return s.yougileIDByName(ctx, token, name), &id
			}
		}
	}

	// 2) Fallback: match a YouGile member by name (legacy behaviour).
	return s.yougileIDByName(ctx, token, name), nil
}

// yougileIDByName returns the YouGile user id whose realName matches name.
func (s *Tasks) yougileIDByName(ctx context.Context, token, name string) []string {
	users, err := s.yg.ListUsers(ctx, token)
	if err != nil {
		s.log.Warn("list yougile users for assignee", "assignee", name, "err", err)
		return nil
	}
	if u, ok := yougile.FindUserByName(users, name); ok {
		return []string{u.ID}
	}
	s.log.Warn("assignee not found in yougile", "assignee", name)
	return nil
}

// orDefault returns def when s is empty.
func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
