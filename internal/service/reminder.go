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

// Tick runs one pass: find due reminders, group by assignee, notify the bot
// once per user (batched), then mark all reminded.
func (rs *ReminderScheduler) Tick(ctx context.Context) {
	due, err := rs.store.ListDueReminders(ctx, ReminderWindow)
	if err != nil {
		rs.log.Error("reminder: list due", "err", err)
		return
	}
	if len(due) == 0 {
		return
	}

	now := time.Now()

	type taskItem struct {
		d       domain.ReminderDue
		overdue bool
		hasTime bool
	}
	// Group tasks by assignee Telegram ID.
	byUser := map[string][]taskItem{}
	for _, d := range due {
		hasTime := !isDateOnlyDeadline(d.Deadline)
		// Дедлайн со временем просрочен по точному моменту; date-only («до конца
		// дня», без времени) — только после конца календарного дня в TZ исполнителя,
		// иначе он считался бы просроченным с самого утра.
		overdue := d.Deadline.Before(now)
		if !hasTime {
			overdue = now.After(endOfDayInTZ(d.Deadline, d.AssigneeTimezone))
		}
		byUser[d.AssigneeTgID] = append(byUser[d.AssigneeTgID], taskItem{d, overdue, hasTime})
	}

	for _, items := range byUser {
		tasks := make([]map[string]any, len(items))
		for i, item := range items {
			tasks[i] = map[string]any{
				"title":    item.d.Title,
				"deadline": item.d.Deadline.Format(time.RFC3339),
				"overdue":  item.overdue,
				"has_time": item.hasTime,
			}
		}
		first := items[0].d
		if !rs.notifyBot(first.AssigneeTgID, first.AssigneeTimezone, tasks) {
			continue
		}
		for _, item := range items {
			if err := rs.store.MarkTaskReminded(ctx, item.d.TaskID); err != nil {
				rs.log.Warn("reminder: mark reminded", "task", item.d.TaskID, "err", err)
			}
		}
	}
}

// notifyBot POSTs a batch of reminders for one user to the bot's /internal/reminder endpoint.
// Returns true on a 200 so the caller can stamp reminded_at for all tasks in the batch.
func (rs *ReminderScheduler) notifyBot(tgID, timezone string, tasks []map[string]any) bool {
	body, err := json.Marshal(map[string]any{
		"tg_id":    tgID,
		"timezone": timezone,
		"tasks":    tasks,
	})
	if err != nil {
		rs.log.Error("reminder: marshal", "tg", tgID, "err", err)
		return false
	}

	req, err := http.NewRequestWithContext(
		context.Background(), http.MethodPost,
		rs.botURL+"/internal/reminder", bytes.NewReader(body),
	)
	if err != nil {
		rs.log.Error("reminder: build request", "tg", tgID, "err", err)
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	if rs.workerSecret != "" {
		req.Header.Set("Authorization", "Bearer "+rs.workerSecret)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		rs.log.Error("reminder: POST failed", "tg", tgID, "err", err)
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		rs.log.Error("reminder: unexpected status", "tg", tgID, "status", resp.StatusCode)
		return false
	}
	rs.log.Info("reminder: sent batch", "tg", tgID, "count", len(tasks))
	return true
}

// isDateOnlyDeadline reports whether the deadline has no clock component (stored
// as midnight UTC by parseDeadline) — i.e. it means "by end of that day".
func isDateOnlyDeadline(t time.Time) bool {
	u := t.UTC()
	return u.Hour() == 0 && u.Minute() == 0 && u.Second() == 0
}

// endOfDayInTZ returns 23:59:59 of the deadline's calendar date in tz. A
// date-only deadline is overdue only once this instant passes.
func endOfDayInTZ(deadline time.Time, tz string) time.Time {
	loc := digestLocation(tz)
	y, m, d := deadline.UTC().Date()
	return time.Date(y, m, d, 23, 59, 59, 0, loc)
}
