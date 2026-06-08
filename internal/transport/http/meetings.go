package http

import (
	"crypto/subtle"
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
	Title    string `json:"title"`
	Assignee string `json:"assignee"`
	Deadline string `json:"deadline"` // ISO-8601 or empty
}

// handleIngestMeeting receives a finished meeting summary from the TS worker and
// creates the extracted tasks in YouGile. Authentication uses the shared
// WORKER_SECRET; if the secret is empty auth is skipped (dev mode only).
func (s *Server) handleIngestMeeting(w http.ResponseWriter, r *http.Request) {
	if s.cfg.WorkerSecret != "" {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.WorkerSecret)) != 1 {
			writeError(w, http.StatusUnauthorized, "invalid worker secret")
			return
		}
	}

	if s.tasks == nil {
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
	if s.repo != nil {
		if ws, err := s.repo.GetWorkspace(r.Context(), req.TenantID); err == nil {
			loc = workspaceLocation(ws.Timezone)
		}
	}

	created := 0
	var failures []string
	for _, t := range req.Tasks {
		if t.Title == "" {
			continue
		}
		in := service.TaskInput{
			TenantID:    req.TenantID,
			Title:       t.Title,
			Description: req.Summary,
			Assignee:    t.Assignee,
			Source:      domain.SourceMeeting,
			Force:       true, // meeting tasks are always created; dedup is not appropriate here
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
			continue
		}
		created++
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"call_id":  req.CallID,
		"created":  created,
		"failures": failures,
	})
}
