package http

import (
	"net/http"

	"ovra/internal/domain"
)

type syncResult struct {
	Checked       int      `json:"checked"`
	Deleted       int      `json:"deleted"`       // missing in YouGile → soft-deleted in Ovra
	Moved         int      `json:"moved"`         // existed but in wrong column → moved
	Skipped       int      `json:"skipped"`       // done tasks with missing cards
	AlreadySynced int      `json:"already_synced"`
	Errors        []string `json:"errors"`
}

// handleSync checks every non-deleted approved task against YouGile:
//   - missing card → re-create in the correct column
//   - card in wrong column (e.g. stale after board re-setup) → move it
//   - done task with missing card → just clear the stale yougile_task_id
func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeError(w, http.StatusServiceUnavailable, "storage unavailable")
		return
	}
	if s.cipher == nil || s.yg == nil {
		writeError(w, http.StatusServiceUnavailable, "disabled: APP_SECRET not set")
		return
	}

	tenant := r.PathValue("tenant")

	ws, err := s.repo.GetWorkspace(r.Context(), tenant)
	if err != nil {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}
	if ws.Columns.Todo == "" {
		writeError(w, http.StatusConflict, "board not resolved — run board/resolve first")
		return
	}

	token, ok := s.loadToken(r.Context(), tenant)
	if !ok {
		writeError(w, http.StatusConflict, "workspace is not connected to YouGile")
		return
	}

	tasks, err := s.repo.ListTasksByTenant(r.Context(), tenant)
	if err != nil {
		s.log.Error("sync: list tasks", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	res := syncResult{Errors: []string{}}

	for _, t := range tasks {
		if t.ApprovalStatus != domain.ApprovalApproved {
			continue
		}
		res.Checked++

		wantCol := syncColumnForStatus(ws, t.Status)
		if wantCol == "" {
			wantCol = ws.Columns.Todo
		}

		if t.YougileTaskID != nil && *t.YougileTaskID != "" {
			info, err := s.yg.GetTask(r.Context(), token, *t.YougileTaskID)
			if err != nil {
				res.Errors = append(res.Errors, t.Title+": "+err.Error())
				continue
			}

			if info != nil {
				needsUpdate := false

				// Un-archive if hidden.
				if info.Archived && t.Status != domain.StatusDone {
					if err := s.yg.UnarchiveTask(r.Context(), token, *t.YougileTaskID); err != nil {
						res.Errors = append(res.Errors, t.Title+": unarchive: "+err.Error())
						continue
					}
					needsUpdate = true
				}

				// Move to correct column if wrong.
				if info.ColumnID != wantCol && t.Status != domain.StatusDone {
					if err := s.yg.MoveTask(r.Context(), token, *t.YougileTaskID, wantCol); err != nil {
						res.Errors = append(res.Errors, t.Title+": move: "+err.Error())
						continue
					}
					needsUpdate = true
				}

				if needsUpdate {
					s.log.Info("sync: card fixed", "task", t.ID, "archived_was", info.Archived, "col_was", info.ColumnID)
					res.Moved++
				} else {
					res.AlreadySynced++
				}
				continue
			}
			// deleted/404 in YouGile — fall through to remove from Ovra.
		}

		// Card is missing in YouGile: user deleted it → soft-delete in Ovra.
		if _, err := s.repo.SoftDeleteTask(r.Context(), t.ID); err != nil {
			res.Errors = append(res.Errors, t.Title+": delete: "+err.Error())
			continue
		}
		s.log.Info("sync: task deleted in yougile → removed from ovra", "task", t.ID)
		res.Deleted++
	}

	writeJSON(w, http.StatusOK, res)
}

func syncColumnForStatus(ws domain.Workspace, status string) string {
	switch status {
	case "todo":
		return ws.Columns.Todo
	case "in_progress":
		return ws.Columns.InProgress
	case "review":
		return ws.Columns.Review
	case "done":
		return ws.Columns.Done
	default:
		return ""
	}
}
