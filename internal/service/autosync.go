package service

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"ovra/internal/domain"
	"ovra/internal/integrations/yougile"
	"ovra/internal/secret"
	"ovra/internal/storage"
)

// AutoSyncStore is the storage slice the auto-sync job needs.
type AutoSyncStore interface {
	ListWorkspaces(ctx context.Context) ([]domain.Workspace, error)
	GetYougileTokenEnc(ctx context.Context, id string) (string, []byte, error)
	ListTasksByTenant(ctx context.Context, tenantID string) ([]domain.Task, error)
	ListUsersByTenant(ctx context.Context, tenantID string) ([]domain.User, error)
	UpsertUser(ctx context.Context, u domain.User) (domain.User, error)
	CreateTask(ctx context.Context, t domain.Task) (domain.Task, error)
	UpdateTask(ctx context.Context, t domain.Task) (domain.Task, error)
	SoftDeleteTask(ctx context.Context, id string) (domain.Task, error)
}

// AutoSyncer runs periodic reconciliation between Ovra and YouGile.
// Direction: YouGile → Ovra (tasks deleted in YouGile are soft-deleted in Ovra).
type AutoSyncer struct {
	store        AutoSyncStore
	yg           *yougile.Client
	cipher       *secret.Cipher
	botURL       string // BotInternalURL; empty → no status-change notifications
	workerSecret string
	log          *slog.Logger
}

// NewAutoSyncer builds an AutoSyncer. botURL (the bot's internal HTTP base URL)
// enables Telegram notifications when a task's status changes; empty disables them.
func NewAutoSyncer(store AutoSyncStore, yg *yougile.Client, cipher *secret.Cipher, botURL, workerSecret string, log *slog.Logger) *AutoSyncer {
	return &AutoSyncer{store: store, yg: yg, cipher: cipher, botURL: botURL, workerSecret: workerSecret, log: log}
}

// statusChange is one task whose board status changed during a sync pass.
type statusChange struct {
	Title     string `json:"title"`
	OldStatus string `json:"old_status"`
	NewStatus string `json:"new_status"`
}

// SyncAll reconciles every connected workspace. Errors per workspace are logged
// but do not stop processing of the remaining ones.
func (s *AutoSyncer) SyncAll(ctx context.Context) {
	workspaces, err := s.store.ListWorkspaces(ctx)
	if err != nil {
		s.log.Error("autosync: list workspaces", "err", err)
		return
	}
	for _, ws := range workspaces {
		if err := s.syncTenant(ctx, ws); err != nil {
			s.log.Error("autosync: tenant failed", "tenant", ws.ID, "err", err)
		}
	}
}

func (s *AutoSyncer) syncTenant(ctx context.Context, ws domain.Workspace) error {
	if ws.Columns.Todo == "" {
		return nil // board not resolved yet — skip
	}

	_, enc, err := s.store.GetYougileTokenEnc(ctx, ws.ID)
	if err != nil || len(enc) == 0 {
		return nil // no credentials — skip silently
	}
	token, err := s.cipher.Open(enc)
	if err != nil {
		return err
	}

	tasks, err := s.store.ListTasksByTenant(ctx, ws.ID)
	if err != nil {
		return err
	}

	users, err := s.store.ListUsersByTenant(ctx, ws.ID)
	if err != nil {
		return err
	}
	yougileToOvra := make(map[string]string, len(users))
	for _, u := range users {
		if u.YougileUserID != "" {
			yougileToOvra[u.YougileUserID] = u.ID
		}
	}

	// Fetch YouGile users once — used for name/stub resolution throughout the pass.
	ygUsers, err := s.yg.ListUsers(ctx, token)
	if err != nil {
		s.log.Warn("autosync: list yougile users", "tenant", ws.ID, "err", err)
		ygUsers = nil
	}
	ygIDToName := make(map[string]string, len(ygUsers))
	for _, u := range ygUsers {
		ygIDToName[u.ID] = u.RealName
	}

	deleted, assigneeUpdated, statusUpdated := 0, 0, 0
	var changes []statusChange
	for _, t := range tasks {
		if t.ApprovalStatus != domain.ApprovalApproved {
			continue
		}
		if t.YougileTaskID == nil || *t.YougileTaskID == "" {
			continue
		}

		info, err := s.yg.GetTask(ctx, token, *t.YougileTaskID)
		if err != nil {
			s.log.Warn("autosync: get task", "task", t.ID, "err", err)
			continue
		}
		if info != nil {
			var changed bool

			// Sync assignee: YouGile → Ovra (with name/stub fallback).
			newAssigneeID := s.resolveAssignee(ctx, ws.ID, info.Assigned, yougileToOvra, ygIDToName, users)
			currentAssigneeID := ""
			if t.AssigneeUserID != nil {
				currentAssigneeID = *t.AssigneeUserID
			}
			newAssigneeIDStr := ""
			if newAssigneeID != nil {
				newAssigneeIDStr = *newAssigneeID
			}
			if currentAssigneeID != newAssigneeIDStr {
				t.AssigneeUserID = newAssigneeID
				changed = true
				assigneeUpdated++
			}

			// Sync status: YouGile column → Ovra status.
			var newStatus string
			if info.Completed {
				newStatus = domain.StatusDone
			} else {
				switch info.ColumnID {
				case ws.Columns.Todo:
					newStatus = domain.StatusTodo
				case ws.Columns.InProgress:
					newStatus = domain.StatusInProgress
				case ws.Columns.Review:
					newStatus = domain.StatusReview
				case ws.Columns.Done:
					newStatus = domain.StatusDone
				}
			}
			if newStatus != "" && newStatus != t.Status {
				changes = append(changes, statusChange{
					Title:     t.Title,
					OldStatus: t.Status,
					NewStatus: newStatus,
				})
				t.Status = newStatus
				changed = true
				statusUpdated++
			}

			if changed {
				if _, err := s.store.UpdateTask(ctx, t); err != nil {
					s.log.Warn("autosync: update task", "task", t.ID, "err", err)
					continue
				}
				s.log.Info("autosync: task updated", "task", t.ID,
					"assignee", newAssigneeIDStr, "status", t.Status)
			}
			continue
		}

		// nil → task deleted in YouGile → soft-delete in Ovra.
		if _, err := s.store.SoftDeleteTask(ctx, t.ID); err != nil {
			if err == storage.ErrNotFound {
				continue // already deleted
			}
			s.log.Warn("autosync: soft delete", "task", t.ID, "err", err)
			continue
		}
		s.log.Info("autosync: task deleted in yougile → removed from ovra",
			"tenant", ws.ID, "task", t.ID, "title", t.Title)
		deleted++
	}

	if deleted > 0 || assigneeUpdated > 0 || statusUpdated > 0 {
		s.log.Info("autosync: tenant done", "tenant", ws.ID, "deleted", deleted, "assignee_updated", assigneeUpdated, "status_updated", statusUpdated)
	}

	// Import tasks created directly in YouGile that are not yet in Ovra.
	if err := s.importBoardTasks(ctx, ws, token, tasks, users, yougileToOvra, ygIDToName); err != nil {
		s.log.Warn("autosync: import board tasks failed", "tenant", ws.ID, "err", err)
	}

	// Notify the group chat about status changes (best-effort).
	if len(changes) > 0 && s.botURL != "" && ws.ChatID != "" {
		s.notifyStatusChanges(ws.ChatID, changes)
	}
	return nil
}

// importBoardTasks pulls tasks from the YouGile board columns and creates in
// Ovra any that are not already tracked (dedup by yougile_task_id).
// It also resolves assignees: first by yougile_user_id, then by name fallback
// against YouGile's user list — and auto-fills yougile_user_id on the Ovra user
// so subsequent syncs don't need to re-fetch.
func (s *AutoSyncer) importBoardTasks(ctx context.Context, ws domain.Workspace, token string, existingTasks []domain.Task, ovraUsers []domain.User, yougileToOvra map[string]string, ygIDToName map[string]string) error {
	// Build set of already-known YouGile task IDs.
	known := make(map[string]struct{}, len(existingTasks))
	for _, t := range existingTasks {
		if t.YougileTaskID != nil && *t.YougileTaskID != "" {
			known[*t.YougileTaskID] = struct{}{}
		}
	}

	type colMapping struct {
		columnID string
		status   string
	}
	cols := []colMapping{
		{ws.Columns.Todo, domain.StatusTodo},
		{ws.Columns.InProgress, domain.StatusInProgress},
		{ws.Columns.Review, domain.StatusReview},
	}

	imported := 0
	for _, cm := range cols {
		if cm.columnID == "" {
			continue
		}
		ygTasks, err := s.yg.ListTasksByColumn(ctx, token, cm.columnID)
		if err != nil {
			s.log.Warn("autosync: list column tasks", "column", cm.columnID, "err", err)
			continue
		}
		for _, yt := range ygTasks {
			if yt.Deleted || yt.Archived || yt.Completed || yt.Title == "" {
				continue
			}
			if _, ok := known[yt.ID]; ok {
				continue
			}
			assigneeID := s.resolveAssignee(ctx, ws.ID, yt.Assigned, yougileToOvra, ygIDToName, ovraUsers)
			var deadline *time.Time
			if yt.Deadline != nil && yt.Deadline.Deadline > 0 {
				dl := time.UnixMilli(yt.Deadline.Deadline)
				deadline = &dl
			}
			ygID := yt.ID
			if _, err := s.store.CreateTask(ctx, domain.Task{
				TenantID:       ws.ID,
				Title:          yt.Title,
				Status:         cm.status,
				ApprovalStatus: domain.ApprovalApproved,
				YougileTaskID:  &ygID,
				AssigneeUserID: assigneeID,
				Deadline:       deadline,
				Source:         domain.SourceYougile,
			}); err != nil {
				s.log.Warn("autosync: import task", "yougile_id", yt.ID, "err", err)
				continue
			}
			known[yt.ID] = struct{}{}
			imported++
		}
	}
	if imported > 0 {
		s.log.Info("autosync: imported tasks from yougile board", "tenant", ws.ID, "count", imported)
	}
	return nil
}

// resolveAssignee returns the Ovra user ID for the first YouGile assignee.
// Strategy:
//  1. Direct lookup by yougile_user_id (already-mapped users).
//  2. Name-based match: find Ovra user with matching full_name, auto-fill
//     yougile_user_id, update in-memory map.
//  3. Create a stub Ovra user from the YouGile realName so the task shows an
//     assignee in the mini-app even before the user registers via the bot.
//     Stub users get tg_id = "yg:<yougile_user_id>" to satisfy the unique key.
func (s *AutoSyncer) resolveAssignee(ctx context.Context, tenantID string, assigned []string, yougileToOvra map[string]string, ygIDToName map[string]string, ovraUsers []domain.User) *string {
	if len(assigned) == 0 {
		return nil
	}
	ygUID := assigned[0]

	// 1. Direct map hit.
	if ovraID, ok := yougileToOvra[ygUID]; ok {
		return &ovraID
	}

	realName := strings.TrimSpace(ygIDToName[ygUID])
	if realName == "" {
		return nil
	}

	// 2. Name-based match against existing Ovra users.
	want := strings.ToLower(realName)
	for i, u := range ovraUsers {
		if strings.ToLower(strings.TrimSpace(u.FullName)) != want {
			continue
		}
		ovraUsers[i].YougileUserID = ygUID
		if _, err := s.store.UpsertUser(ctx, ovraUsers[i]); err != nil {
			s.log.Warn("autosync: set yougile_user_id", "user", u.ID, "err", err)
		} else {
			yougileToOvra[ygUID] = u.ID
		}
		id := u.ID
		return &id
	}

	// 3. Create a stub user so the task has an assignee.
	// tg_id = "yg:<yougile_user_id>" is unique and won't collide with real Telegram IDs.
	stub, err := s.store.UpsertUser(ctx, domain.User{
		TenantID:      tenantID,
		TgID:          "yg:" + ygUID,
		FullName:      realName,
		YougileUserID: ygUID,
	})
	if err != nil {
		s.log.Warn("autosync: create stub user", "yougile_id", ygUID, "err", err)
		return nil
	}
	yougileToOvra[ygUID] = stub.ID
	s.log.Info("autosync: created stub user for yougile assignee", "tenant", tenantID, "name", realName)
	id := stub.ID
	return &id
}

// notifyStatusChanges POSTs detected status changes to the bot's internal
// endpoint so it can post a summary to the group chat. Best-effort; logged only.
func (s *AutoSyncer) notifyStatusChanges(chatID string, changes []statusChange) {
	body, err := json.Marshal(map[string]any{
		"chat_id": chatID,
		"changes": changes,
	})
	if err != nil {
		s.log.Error("autosync: marshal status changes", "err", err)
		return
	}

	req, err := http.NewRequestWithContext(
		context.Background(), http.MethodPost,
		s.botURL+"/internal/status-change", bytes.NewReader(body),
	)
	if err != nil {
		s.log.Error("autosync: build status-change request", "err", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if s.workerSecret != "" {
		req.Header.Set("Authorization", "Bearer "+s.workerSecret)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		s.log.Error("autosync: status-change POST failed", "err", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		s.log.Error("autosync: status-change unexpected status", "status", resp.StatusCode)
	}
}
