package http

import (
	"net/http"
	"sync/atomic"
)

// runtimeMetrics holds process-lifetime counters incremented as events occur.
// Values reset on restart; use for rate/error dashboards, not auditing.
type runtimeMetrics struct {
	SummariesReceived atomic.Int64
	SummariesFailed   atomic.Int64
	TasksCreated      atomic.Int64
	TasksFailed       atomic.Int64
}

// svcMetrics is the singleton incremented by handlers.
var svcMetrics runtimeMetrics

// handleMetrics returns current counters as JSON. No auth — read-only and
// contains no sensitive data. Restrict at the network/proxy level if needed.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"summaries_received": svcMetrics.SummariesReceived.Load(),
		"summaries_failed":   svcMetrics.SummariesFailed.Load(),
		"tasks_created":      svcMetrics.TasksCreated.Load(),
		"tasks_failed":       svcMetrics.TasksFailed.Load(),
	})
}
