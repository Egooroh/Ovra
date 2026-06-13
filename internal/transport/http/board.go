package http

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"ovra/internal/columns"
	"ovra/internal/domain"
	"ovra/internal/storage"
)

// boardOverride lets the host correct the auto-mapping by passing explicit
// column ids. Any non-empty field switches the request to manual-save mode.
type boardOverride struct {
	Todo       string `json:"todo"`
	InProgress string `json:"in_progress"`
	Review     string `json:"review"`
	Done       string `json:"done"`
}

func (o boardOverride) any() bool {
	return o.Todo != "" || o.InProgress != "" || o.Review != "" || o.Done != ""
}

// columnAssignment is the JSON view of one resolved column.
type columnAssignment struct {
	ColumnID string `json:"column_id"`
	Title    string `json:"title"`
	Status   string `json:"status"`
	Method   string `json:"method"`
}

// handleResolveBoard maps an existing YouGile board's columns to Ovra statuses
// and stores the mapping. With an explicit body it saves the host's override;
// otherwise it auto-resolves the first board of the workspace's project.
func (s *Server) handleResolveBoard(w http.ResponseWriter, r *http.Request) {
	if s.cipher == nil || s.yg == nil {
		writeError(w, http.StatusServiceUnavailable, "board resolution disabled: APP_SECRET not set")
		return
	}
	tenant := r.PathValue("tenant")

	ws, err := s.repo.GetWorkspace(r.Context(), tenant)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "workspace not found")
			return
		}
		s.log.Error("get workspace", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Manual override path — save the host's explicit mapping and return.
	var ov boardOverride
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&ov) // empty body is fine
	if ov.any() {
		cols := domain.Columns(ov)
		if err := s.repo.SetWorkspaceColumns(r.Context(), tenant, cols); err != nil {
			s.log.Error("save columns override", "tenant", tenant, "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"saved": true, "mapping": cols})
		return
	}

	// Auto-resolve path — needs the YouGile token.
	token, ok := s.workspaceToken(w, r, tenant)
	if !ok {
		return
	}

	result, boardID, err := s.resolveBoardColumns(r.Context(), tenant, ws.YougileProjectID, token)
	if err != nil {
		if errors.Is(err, errNoBoards) {
			writeError(w, http.StatusNotFound, "no boards in the workspace project")
			return
		}
		writeError(w, http.StatusBadGateway, "yougile: "+err.Error())
		return
	}
	mapping := domain.Columns(result.Mapping)
	if err := s.repo.SetWorkspaceColumns(r.Context(), tenant, mapping); err != nil {
		s.log.Error("save resolved columns", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	assignments := make([]columnAssignment, len(result.Assignments))
	for i, a := range result.Assignments {
		assignments[i] = columnAssignment{ColumnID: a.ColumnID, Title: a.Title, Status: a.Status, Method: a.Method}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"board_id":    boardID,
		"confident":   result.Confident, // true → mapping is safe to trust without review
		"complete":    result.Mapping.Complete(),
		"mapping":     mapping,
		"assignments": assignments,
	})
}

// errNoBoards signals that the workspace's YouGile project has no boards.
var errNoBoards = errors.New("no boards in the workspace project")

// resolveBoardColumns fetches the first board of the given YouGile project and
// classifies its columns into Ovra statuses (dictionary → optional AI → ordinal).
// It does NOT persist anything — the caller stores result.Mapping. The caller
// supplies an already-decrypted token. Returns errNoBoards when the project has
// no boards; YouGile transport errors are returned unwrapped (callers map them
// to 502). Shared by handleResolveBoard (bot, /v1) and the mini-app select-project.
func (s *Server) resolveBoardColumns(ctx context.Context, tenant, projectID, token string) (columns.Result, string, error) {
	boards, err := s.yg.ListBoards(ctx, token, projectID)
	if err != nil {
		return columns.Result{}, "", err
	}
	if len(boards) == 0 {
		return columns.Result{}, "", errNoBoards
	}
	cols, err := s.yg.ListColumns(ctx, token, boards[0].ID)
	if err != nil {
		return columns.Result{}, "", err
	}
	result, aiErr := columns.ResolveWithAI(ctx, cols, s.classifier)
	if aiErr != nil {
		s.log.Warn("ai column classifier failed; used dictionary+ordinal", "tenant", tenant, "err", aiErr)
	}
	return result, boards[0].ID, nil
}

// workspaceToken loads and decrypts the workspace's YouGile token, writing the
// appropriate error response and returning ok=false on failure.
func (s *Server) workspaceToken(w http.ResponseWriter, r *http.Request, tenant string) (string, bool) {
	_, enc, err := s.repo.GetYougileTokenEnc(r.Context(), tenant)
	if err != nil {
		s.log.Error("get token", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return "", false
	}
	if len(enc) == 0 {
		writeError(w, http.StatusConflict, "workspace is not connected to YouGile")
		return "", false
	}
	token, err := s.cipher.Open(enc)
	if err != nil {
		s.log.Error("decrypt token", "tenant", tenant, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return "", false
	}
	return token, true
}
