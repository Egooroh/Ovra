package http

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

	"ovra/internal/domain"
	"ovra/internal/service"
)

// ingestMeetingRequest is the body of POST /v1/meetings/summary — sent by the
// TS meeting-worker after it finishes generating a summary for a call.
type ingestMeetingRequest struct {
	TenantID   string            `json:"tenant_id"`
	CallID     string            `json:"call_id"`
	Title      string            `json:"title"`
	StartedAt  string            `json:"started_at"` // ISO-8601
	EndedAt    string            `json:"ended_at"`   // ISO-8601
	Summary    string            `json:"summary"`
	Tasks      []ingestTaskInput `json:"tasks"`
	Transcript string            `json:"transcript"`
}

type ingestTaskInput struct {
	Title       string `json:"title"`
	Assignee    string `json:"assignee"`
	Deadline    string `json:"deadline"`    // ISO-8601 or empty
	Description string `json:"description"` // per-task context from the LLM, or empty
}

// meetingDoneNotification is the payload sent to the bot's internal endpoint.
type meetingDoneNotification struct {
	ChatID   string            `json:"chat_id"`
	TenantID string            `json:"tenant_id"`
	Title    string            `json:"title"`
	Summary  string            `json:"summary"`
	Tasks    []ingestTaskInput `json:"tasks"`
}

// handleIngestMeeting receives a finished meeting summary from the TS worker.
// When BOT_INTERNAL_URL is configured the tasks are forwarded to the bot for
// per-task user confirmation; otherwise they are created in YouGile directly
// (legacy behaviour).
func (s *Server) handleIngestMeeting(w http.ResponseWriter, r *http.Request) {
	if s.cfg.WorkerSecret != "" {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.WorkerSecret)) != 1 {
			writeError(w, http.StatusUnauthorized, "invalid worker secret")
			return
		}
	}

	if s.tasks == nil && s.cfg.BotInternalURL == "" {
		writeError(w, http.StatusServiceUnavailable, "task publishing disabled: APP_SECRET not set")
		return
	}

	var req ingestMeetingRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.TenantID == "" || req.CallID == "" {
		writeError(w, http.StatusBadRequest, "tenant_id and call_id are required")
		return
	}

	loc := workspaceLocation("")
	chatID := ""
	if s.repo != nil {
		if ws, err := s.repo.GetWorkspace(r.Context(), req.TenantID); err == nil {
			loc = workspaceLocation(ws.Timezone)
			chatID = ws.ChatID
		}
	}

	svcMetrics.SummariesReceived.Add(1)

	// If the bot URL is configured and we have a chat ID, forward to the bot for
	// interactive per-task confirmation in the group chat.
	if s.cfg.BotInternalURL != "" && chatID != "" {
		go s.notifyBotMeetingDone(req, chatID)
		writeJSON(w, http.StatusOK, map[string]any{
			"call_id":  req.CallID,
			"pending":  len(req.Tasks),
			"via_bot":  true,
		})
		return
	}

	// Fallback: create tasks automatically (no bot confirmation).
	if s.tasks == nil {
		writeError(w, http.StatusServiceUnavailable, "task publishing disabled: APP_SECRET not set")
		return
	}

	created := 0
	var failures []string
	for _, t := range req.Tasks {
		if t.Title == "" {
			continue
		}
		// Prefer the task's own LLM-written description; fall back to the
		// whole-meeting summary when the model left it empty.
		desc := t.Description
		if desc == "" {
			desc = req.Summary
		}
		in := service.TaskInput{
			TenantID:    req.TenantID,
			Title:       t.Title,
			Description: desc,
			Assignee:    t.Assignee,
			Source:      domain.SourceMeeting,
			Force:       true,
		}
		if t.Deadline != "" {
			if dl, hasTime, err := parseDeadline(t.Deadline, loc); err == nil {
				in.Deadline = &dl
				in.DeadlineHasTime = hasTime
			} else {
				s.log.Warn("ingest meeting: unparseable deadline",
					"call_id", req.CallID, "task", t.Title, "deadline", t.Deadline)
			}
		}
		if _, err := s.tasks.CreateAndPublish(r.Context(), in); err != nil {
			s.log.Error("ingest meeting task",
				"call_id", req.CallID, "title", t.Title, "err", err)
			failures = append(failures, t.Title+": "+err.Error())
			svcMetrics.TasksFailed.Add(1)
			continue
		}
		svcMetrics.TasksCreated.Add(1)
		created++
	}

	if len(failures) > 0 && created == 0 {
		svcMetrics.SummariesFailed.Add(1)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"call_id":  req.CallID,
		"created":  created,
		"failures": failures,
	})
}

// notifyBotMeetingDone POSTs the meeting summary and task list to the bot's
// internal HTTP endpoint so the bot can send per-task confirmation messages to
// the group chat. Runs in a goroutine; errors are logged but not fatal.
func (s *Server) notifyBotMeetingDone(req ingestMeetingRequest, chatID string) {
	notification := meetingDoneNotification{
		ChatID:   chatID,
		TenantID: req.TenantID,
		Title:    req.Title,
		Summary:  req.Summary,
		Tasks:    req.Tasks,
	}

	body, err := json.Marshal(notification)
	if err != nil {
		s.log.Error("notifyBotMeetingDone: marshal", "err", err)
		return
	}

	httpReq, err := http.NewRequestWithContext(
		context.Background(),
		http.MethodPost,
		s.cfg.BotInternalURL+"/internal/meeting-done",
		bytes.NewReader(body),
	)
	if err != nil {
		s.log.Error("notifyBotMeetingDone: build request", "err", err)
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if s.cfg.WorkerSecret != "" {
		httpReq.Header.Set("Authorization", "Bearer "+s.cfg.WorkerSecret)
	}

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		s.log.Error("notifyBotMeetingDone: POST failed", "url", s.cfg.BotInternalURL, "err", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		s.log.Error("notifyBotMeetingDone: unexpected status", "status", resp.StatusCode)
	}
}
