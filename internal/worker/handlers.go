package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"ovra/internal/domain"
	"ovra/internal/queue"
	"ovra/internal/service"
)

// MVP event types (the contract shared with У2/У3).
const (
	EventTaskCreate      = "task_create"
	EventChatMessage     = "chat_message"
	EventTranscriptReady = "transcript_ready"
)

// TaskCreator is the slice of the task service the task_create handler needs.
type TaskCreator interface {
	CreateAndPublish(ctx context.Context, in service.TaskInput) (domain.Task, error)
}

// taskCreatePayload is the payload of a task_create event (produced by Claude).
type taskCreatePayload struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Assignee    string `json:"assignee"`
	Deadline    string `json:"deadline"` // RFC3339, optional
}

// TaskCreateHandler builds the handler that turns a task_create event into a
// persisted task and a YouGile card.
func TaskCreateHandler(svc TaskCreator) queue.Handler {
	return func(ctx context.Context, e queue.Event) error {
		var p taskCreatePayload
		if err := json.Unmarshal(e.Payload, &p); err != nil {
			return fmt.Errorf("decode task_create payload: %w", err)
		}
		if p.Title == "" {
			return fmt.Errorf("task_create: title is required")
		}

		in := service.TaskInput{
			TenantID:    e.TenantID,
			Title:       p.Title,
			Description: p.Description,
			Assignee:    p.Assignee,
			Source:      domain.SourceChat,
		}
		if p.Deadline != "" {
			dl, err := time.Parse(time.RFC3339, p.Deadline)
			if err != nil {
				return fmt.Errorf("task_create: deadline must be RFC3339: %w", err)
			}
			in.Deadline = &dl
		}

		_, err := svc.CreateAndPublish(ctx, in)
		return err
	}
}
