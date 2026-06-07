// Package columns maps an arbitrary YouGile board's columns onto Ovra's four
// canonical statuses (todo / in_progress / review / done).
//
// Boards differ team-to-team ("Сделать" vs "To Do" vs "Backlog"), so when the
// bot connects to an existing board we resolve the mapping once and store it.
// Resolution is deterministic: a synonym dictionary first, then an ordinal
// fallback (leftmost → todo, rightmost → done). No LLM on this path — it is a
// one-time onboarding step, and the host confirms the result.
package columns

import (
	"context"
	"strings"
	"unicode"

	"ovra/internal/domain"
	"ovra/internal/integrations/yougile"
)

// synonyms holds normalised column-name variants per canonical status.
// Keep entries lowercase and already normalised (see normalize).
var synonyms = map[string][]string{
	domain.StatusTodo: {
		"todo", "to do", "сделать", "надо сделать", "нужно сделать", "к выполнению",
		"бэклог", "беклог", "backlog", "очередь", "новые", "новая", "входящие",
		"план", "задачи", "open", "ожидает", "запланировано",
	},
	domain.StatusInProgress: {
		"in progress", "inprogress", "в работе", "в процессе", "делается",
		"выполняется", "doing", "wip", "процесс", "разработка",
	},
	domain.StatusReview: {
		"review", "ревью", "на проверке", "проверка", "тестирование", "тест",
		"qa", "testing", "на ревью", "контроль", "согласование",
	},
	domain.StatusDone: {
		"done", "готово", "выполнено", "завершено", "закрыто", "сделано",
		"complete", "completed", "closed", "finished", "выполнена", "профит",
	},
}

// statusOrder is the canonical left-to-right board order.
var statusOrder = []string{
	domain.StatusTodo, domain.StatusInProgress, domain.StatusReview, domain.StatusDone,
}

// Mapping holds the resolved column id for each canonical status ("" if none).
type Mapping struct {
	Todo       string
	InProgress string
	Review     string
	Done       string
}

// Complete reports whether every canonical status got a column.
func (m Mapping) Complete() bool {
	return m.Todo != "" && m.InProgress != "" && m.Review != "" && m.Done != ""
}

// Assignment records how a single board column was classified (for the
// confirmation UI shown to the host).
type Assignment struct {
	ColumnID string
	Title    string
	Status   string // canonical status, "" if unassigned
	Method   string // "dictionary" | "ordinal" | "unassigned"
}

// Result is the outcome of resolving a board's columns.
type Result struct {
	Mapping     Mapping
	Assignments []Assignment
	// Confident is true when the dictionary alone matched all four statuses
	// (no ordinal guessing was needed) — safe to auto-save without asking.
	Confident bool
}

// Resolve maps board columns to canonical statuses using the dictionary and an
// ordinal fallback only (no AI).
func Resolve(cols []yougile.Column) Result {
	res, _ := resolveInternal(context.Background(), cols, nil)
	return res
}

// resolveInternal runs the dictionary pass, then an optional AI pass (only when
// c != nil and the dictionary left statuses unfilled), then the ordinal
// fallback. A classifier error is returned to the caller, but the Result is
// still complete (ordinal fills any gaps) — so callers can log and proceed.
func resolveInternal(ctx context.Context, cols []yougile.Column, c Classifier) (Result, error) {
	res := Result{Assignments: make([]Assignment, len(cols))}
	byStatus := map[string]string{} // status -> column id (first match wins)
	used := make([]bool, len(cols))

	// Pass 1 — dictionary.
	for i, col := range cols {
		res.Assignments[i] = Assignment{ColumnID: col.ID, Title: col.Title, Method: "unassigned"}
		st, ok := matchStatus(normalize(col.Title))
		if !ok {
			continue
		}
		res.Assignments[i].Status = st
		res.Assignments[i].Method = "dictionary"
		if byStatus[st] == "" {
			byStatus[st] = col.ID
			used[i] = true
		}
	}

	res.Confident = len(byStatus) == len(statusOrder)

	// Pass 2 — AI fallback for the long tail (optional).
	var aiErr error
	if c != nil && len(byStatus) < len(statusOrder) {
		aiErr = classifyPass(ctx, c, cols, used, byStatus, res.Assignments)
	}

	// Pass 3 — ordinal fallback for whatever is still empty.
	fillOrdinal(cols, used, byStatus, res.Assignments)

	res.Mapping = Mapping{
		Todo:       byStatus[domain.StatusTodo],
		InProgress: byStatus[domain.StatusInProgress],
		Review:     byStatus[domain.StatusReview],
		Done:       byStatus[domain.StatusDone],
	}
	return res, aiErr
}

// fillOrdinal assigns leftover columns to missing statuses by position:
// leftmost free → todo, rightmost free → done, then remaining left→right to
// in_progress and review.
func fillOrdinal(cols []yougile.Column, used []bool, byStatus map[string]string, asg []Assignment) {
	free := func() []int {
		var idx []int
		for i := range cols {
			if !used[i] {
				idx = append(idx, i)
			}
		}
		return idx
	}
	assign := func(i int, status string) {
		used[i] = true
		byStatus[status] = cols[i].ID
		if asg[i].Status == "" {
			asg[i].Status = status
			asg[i].Method = "ordinal"
		}
	}

	if byStatus[domain.StatusTodo] == "" {
		if f := free(); len(f) > 0 {
			assign(f[0], domain.StatusTodo)
		}
	}
	if byStatus[domain.StatusDone] == "" {
		if f := free(); len(f) > 0 {
			assign(f[len(f)-1], domain.StatusDone)
		}
	}
	if byStatus[domain.StatusInProgress] == "" {
		if f := free(); len(f) > 0 {
			assign(f[0], domain.StatusInProgress)
		}
	}
	if byStatus[domain.StatusReview] == "" {
		if f := free(); len(f) > 0 {
			assign(f[0], domain.StatusReview)
		}
	}
}

// matchStatus finds the canonical status for a normalised title: exact synonym
// first, then substring containment.
func matchStatus(norm string) (string, bool) {
	if norm == "" {
		return "", false
	}
	for _, st := range statusOrder {
		for _, syn := range synonyms[st] {
			if norm == syn {
				return st, true
			}
		}
	}
	for _, st := range statusOrder {
		for _, syn := range synonyms[st] {
			if strings.Contains(norm, syn) {
				return st, true
			}
		}
	}
	return "", false
}

// normalize lowercases, drops emoji/punctuation and collapses whitespace.
func normalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	prevSpace := false
	for _, r := range s {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
			prevSpace = false
		case unicode.IsSpace(r), r == '-', r == '_', r == '/':
			if !prevSpace && b.Len() > 0 {
				b.WriteRune(' ')
				prevSpace = true
			}
		}
	}
	return strings.TrimSpace(b.String())
}
