package service

import (
	"context"
	"log/slog"

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
	SoftDeleteTask(ctx context.Context, id string) (domain.Task, error)
}

// AutoSyncer runs periodic reconciliation between Ovra and YouGile.
// Direction: YouGile → Ovra (tasks deleted in YouGile are soft-deleted in Ovra).
type AutoSyncer struct {
	store  AutoSyncStore
	yg     *yougile.Client
	cipher *secret.Cipher
	log    *slog.Logger
}

// NewAutoSyncer builds an AutoSyncer.
func NewAutoSyncer(store AutoSyncStore, yg *yougile.Client, cipher *secret.Cipher, log *slog.Logger) *AutoSyncer {
	return &AutoSyncer{store: store, yg: yg, cipher: cipher, log: log}
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

	deleted := 0
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
			// Task still exists and is not deleted — check if status changed.
			if info.Completed && t.Status != domain.StatusDone {
				s.log.Info("autosync: task completed in yougile, but that direction is not synced yet",
					"task", t.ID)
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

	if deleted > 0 {
		s.log.Info("autosync: tenant done", "tenant", ws.ID, "deleted", deleted)
	}
	return nil
}
