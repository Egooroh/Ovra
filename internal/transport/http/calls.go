package http

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// scheduleCallBody is the request body for POST /v1/workspaces/{tenant}/calls.
// The Telegram bot sends this when a user shares a Telemost link in a group chat.
type scheduleCallBody struct {
	// JoinURL is the full Telemost meeting URL, e.g. https://telemost.yandex.ru/j/...
	JoinURL  string `json:"join_url"`
	Title    string `json:"title,omitempty"`
	StartsAt string `json:"starts_at,omitempty"` // ISO-8601; defaults to now
	EndsAt   string `json:"ends_at,omitempty"`   // ISO-8601; optional
}

// handleScheduleCall accepts a Telemost link from the Telegram bot and forwards
// it to the meeting-worker API for scheduling. The meeting-worker deduplicates
// by joinUrl so double-sends are safe.
func (s *Server) handleScheduleCall(w http.ResponseWriter, r *http.Request) {
	tenantID := r.PathValue("tenant")

	if s.repo != nil {
		if _, err := s.repo.GetWorkspace(r.Context(), tenantID); err != nil {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
	}

	var body scheduleCallBody
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.JoinURL == "" {
		writeError(w, http.StatusBadRequest, "join_url is required")
		return
	}
	if !strings.Contains(body.JoinURL, "telemost.yandex.ru") {
		writeError(w, http.StatusBadRequest, "join_url must be a Telemost link (telemost.yandex.ru)")
		return
	}

	if s.cfg.MeetingWorkerURL == "" {
		writeError(w, http.StatusServiceUnavailable, "meeting worker not configured (MEETING_WORKER_URL not set)")
		return
	}

	// Forward to meeting-worker with organizationId set from the workspace tenant.
	payload, _ := json.Marshal(map[string]any{
		"joinUrl":        body.JoinURL,
		"title":          body.Title,
		"organizationId": tenantID,
		"startsAt":       body.StartsAt,
		"endsAt":         body.EndsAt,
	})

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	mreq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.cfg.MeetingWorkerURL+"/v1/calls", bytes.NewReader(payload))
	if err != nil {
		s.log.Error("schedule call: build request", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	mreq.Header.Set("Content-Type", "application/json")
	if s.cfg.WorkerSecret != "" {
		mreq.Header.Set("Authorization", "Bearer "+s.cfg.WorkerSecret)
	}

	resp, err := http.DefaultClient.Do(mreq)
	if err != nil {
		s.log.Error("schedule call: meeting worker unreachable", "err", err)
		writeError(w, http.StatusBadGateway, "meeting worker unreachable")
		return
	}
	defer resp.Body.Close()

	var result map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&result)

	if resp.StatusCode >= 300 {
		s.log.Error("schedule call: meeting worker error", "status", resp.StatusCode, "body", result)
		writeError(w, http.StatusBadGateway, "meeting worker returned an error")
		return
	}

	writeJSON(w, http.StatusAccepted, result)
}
