package service

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"ovra/internal/domain"
)

// ReminderStore is the storage slice the reminder scheduler needs.
type ReminderStore interface {
	ListDueReminders(ctx context.Context, within time.Duration) ([]domain.ReminderDue, error)
	MarkTaskReminded(ctx context.Context, taskID string) error
}

// ReminderWindow is how far ahead a deadline triggers a reminder. Tasks due
// within this window (or already overdue) get one PM nudge to the assignee.
const ReminderWindow = 24 * time.Hour

// ReminderScheduler nudges task assignees in their private Telegram chat about
// approaching or overdue deadlines. Each task is reminded at most once (tracked
// by tasks.reminded_at). The bot owns the actual DM; this only decides who.
type ReminderScheduler struct {
	store        ReminderStore
	botURL       string
	workerSecret string
	log          *slog.Logger
}

// NewReminderScheduler builds a ReminderScheduler.
func NewReminderScheduler(store ReminderStore, botURL, workerSecret string, log *slog.Logger) *ReminderScheduler {
	return &ReminderScheduler{store: store, botURL: botURL, workerSecret: workerSecret, log: log}
}

// Tick runs one pass: find due reminders, notify the bot, mark each reminded.
func (rs *ReminderScheduler) Tick(ctx context.Context) {
	due, err := rs.store.ListDueReminders(ctx, ReminderWindow)
	if err != nil {
		rs.log.Error("reminder: list due", "err", err)
		return
	}
	now := time.Now()
	for _, d := range due {
		if rs.notifyBot(d, d.Deadline.Before(now)) {
			if err := rs.store.MarkTaskReminded(ctx, d.TaskID); err != nil {
				rs.log.Warn("reminder: mark reminded", "task", d.TaskID, "err", err)
			}
		}
	}
}

// notifyBot POSTs the reminder to the bot's /internal/reminder endpoint.
// Returns true on a 200 so the caller can stamp reminded_at.
func (rs *ReminderScheduler) notifyBot(d domain.ReminderDue, overdue bool) bool {
	body, err := json.Marshal(map[string]any{
		"tg_id":    d.AssigneeTgID,
		"title":    d.Title,
		"deadline": d.Deadline.Format(time.RFC3339),
		"overdue":  overdue,
		"timezone": d.AssigneeTimezone,
	})
	if err != nil {
		rs.log.Error("reminder: marshal", "task", d.TaskID, "err", err)
		return false
	}

	req, err := http.NewRequestWithContext(
		context.Background(), http.MethodPost,
		rs.botURL+"/internal/reminder", bytes.NewReader(body),
	)
	if err != nil {
		rs.log.Error("reminder: build request", "task", d.TaskID, "err", err)
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	if rs.workerSecret != "" {
		req.Header.Set("Authorization", "Bearer "+rs.workerSecret)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		rs.log.Error("reminder: POST failed", "task", d.TaskID, "err", err)
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		rs.log.Error("reminder: unexpected status", "task", d.TaskID, "status", resp.StatusCode)
		return false
	}
	rs.log.Info("reminder: sent", "task", d.TaskID, "tg", d.AssigneeTgID, "overdue", overdue)
	return true
}
