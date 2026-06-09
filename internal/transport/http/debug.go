package http

import (
	"net/http"
)

// handleDebugBoards lists all boards in the workspace's project and the
// current column of the first non-done task — useful when diagnosing sync issues.
func (s *Server) handleDebugBoards(w http.ResponseWriter, r *http.Request) {
	if s.cipher == nil || s.yg == nil {
		writeError(w, http.StatusServiceUnavailable, "disabled")
		return
	}
	tenant := r.PathValue("tenant")
	ws, err := s.repo.GetWorkspace(r.Context(), tenant)
	if err != nil {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}
	token, ok := s.loadToken(r.Context(), tenant)
	if !ok {
		writeError(w, http.StatusConflict, "not connected")
		return
	}

	boards, err := s.yg.ListBoards(r.Context(), token, ws.YougileProjectID)
	if err != nil {
		writeError(w, http.StatusBadGateway, "list boards: "+err.Error())
		return
	}

	type boardInfo struct {
		ID      string            `json:"id"`
		Title   string            `json:"title"`
		Columns []map[string]string `json:"columns"`
	}
	result := make([]boardInfo, 0, len(boards))
	for _, b := range boards {
		cols, _ := s.yg.ListColumns(r.Context(), token, b.ID)
		colOut := make([]map[string]string, len(cols))
		for i, c := range cols {
			colOut[i] = map[string]string{"id": c.ID, "title": c.Title}
		}
		result = append(result, boardInfo{ID: b.ID, Title: b.Title, Columns: colOut})
	}

	// Check where the first non-done task actually sits in YouGile.
	tasks, _ := s.repo.ListTasksByTenant(r.Context(), tenant)
	type taskLoc struct {
		Title     string `json:"title"`
		OvraCol   string `json:"ovra_col"`
		YgCol     string `json:"yg_col"`
		YgTaskID  string `json:"yg_task_id"`
		Completed bool   `json:"completed"`
		Archived  bool   `json:"archived"`
	}
	var taskLocs []taskLoc
	for _, t := range tasks {
		if t.YougileTaskID == nil || t.Status == "done" {
			continue
		}
		info, err := s.yg.GetTask(r.Context(), token, *t.YougileTaskID)
		col := ""
		var completed, archived bool
		if err == nil && info != nil {
			col = info.ColumnID
			completed = info.Completed
			archived = info.Archived
		}
		taskLocs = append(taskLocs, taskLoc{
			Title:     t.Title,
			OvraCol:   ws.Columns.Todo,
			YgCol:     col,
			YgTaskID:  *t.YougileTaskID,
			Completed: completed,
			Archived:  archived,
		})
		if len(taskLocs) >= 3 {
			break
		}
	}

	// Raw YouGile response for the first non-done task — reveals all fields incl. deleted.
	var rawTask map[string]any
	for _, t := range tasks {
		if t.YougileTaskID != nil && t.Status != "done" {
			rawTask, _ = s.yg.GetTaskRaw(r.Context(), token, *t.YougileTaskID)
			break
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"configured_col_todo": ws.Columns.Todo,
		"yougile_project_id":  ws.YougileProjectID,
		"boards":              result,
		"task_locations":      taskLocs,
		"raw_task":            rawTask,
	})
}
