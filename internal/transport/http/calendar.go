package http

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// handleListCalendarAccounts proxies GET /v1/workspaces/{tenant}/calendar/accounts
// to the meeting-worker, filtering by organizationId = tenant.
func (s *Server) handleListCalendarAccounts(w http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenant")
	s.proxyToWorker(w, r, http.MethodGet, "/v1/calendar/accounts?org="+tenant, nil)
}

// handleCreateCalendarAccount proxies POST /v1/workspaces/{tenant}/calendar/accounts
// to the meeting-worker. organizationId is injected from the path so callers
// (the Telegram bot) don't have to send it explicitly.
func (s *Server) handleCreateCalendarAccount(w http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenant")

	var body map[string]any
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	body["organizationId"] = tenant

	payload, _ := json.Marshal(body)
	s.proxyToWorker(w, r, http.MethodPost, "/v1/calendar/accounts", payload)
}

// handleDeleteCalendarAccount proxies DELETE /v1/workspaces/{tenant}/calendar/accounts/{id}
// to the meeting-worker (soft-delete).
func (s *Server) handleDeleteCalendarAccount(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.proxyToWorker(w, r, http.MethodDelete, "/v1/calendar/accounts/"+id, nil)
}

// proxyToWorker forwards a request to the meeting-worker at workerPath.
// body is the JSON payload; pass nil for requests without a body (GET, DELETE).
func (s *Server) proxyToWorker(w http.ResponseWriter, r *http.Request, method, workerPath string, body []byte) {
	if s.cfg.MeetingWorkerURL == "" {
		writeError(w, http.StatusServiceUnavailable, "meeting worker not configured (MEETING_WORKER_URL not set)")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if body == nil {
		body = []byte{}
	}
	req, err := http.NewRequestWithContext(ctx, method,
		s.cfg.MeetingWorkerURL+workerPath, bytes.NewReader(body))
	if err != nil {
		s.log.Error("proxyToWorker: build request", "path", workerPath, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if s.cfg.WorkerSecret != "" {
		req.Header.Set("Authorization", "Bearer "+s.cfg.WorkerSecret)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		s.log.Error("proxyToWorker: worker unreachable", "path", workerPath, "err", err)
		writeError(w, http.StatusBadGateway, "meeting worker unreachable")
		return
	}
	defer resp.Body.Close()

	var result any
	_ = json.NewDecoder(resp.Body).Decode(&result)
	writeJSON(w, resp.StatusCode, result)
}
