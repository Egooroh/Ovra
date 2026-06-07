package columns

import (
	"context"

	"ovra/internal/integrations/yougile"
)

// Classifier is the optional AI fallback. It maps board column titles that the
// synonym dictionary couldn't place to canonical statuses. Plug an
// implementation (e.g. an OpenRouter client) to handle exotic column names;
// pass nil to disable it (the resolver then uses only dictionary + ordinal).
type Classifier interface {
	// Classify returns a status for each input title, aligned by index. Each
	// element must be one of domain.Status* (todo/in_progress/review/done) or
	// "" when the title can't be classified.
	Classify(ctx context.Context, titles []string) ([]string, error)
}

// ResolveWithAI is Resolve plus an AI fallback that runs between the dictionary
// and the ordinal pass. With c == nil it is identical to Resolve. The returned
// error reports a classifier failure (if any); the Result is always complete
// because the ordinal pass fills any remaining gaps.
func ResolveWithAI(ctx context.Context, cols []yougile.Column, c Classifier) (Result, error) {
	return resolveInternal(ctx, cols, c)
}

// classifyPass sends the still-unassigned columns to the classifier and applies
// any confident answers (a status that isn't already filled).
func classifyPass(ctx context.Context, c Classifier, cols []yougile.Column, used []bool, byStatus map[string]string, asg []Assignment) error {
	var idx []int
	var titles []string
	for i := range cols {
		if !used[i] {
			idx = append(idx, i)
			titles = append(titles, cols[i].Title)
		}
	}
	if len(titles) == 0 {
		return nil
	}

	statuses, err := c.Classify(ctx, titles)
	if err != nil {
		return err
	}

	for k := 0; k < len(statuses) && k < len(idx); k++ {
		st := statuses[k]
		if !isCanonical(st) || byStatus[st] != "" {
			continue
		}
		i := idx[k]
		byStatus[st] = cols[i].ID
		used[i] = true
		if asg[i].Status == "" {
			asg[i].Status = st
			asg[i].Method = "ai"
		}
	}
	return nil
}

// isCanonical reports whether s is one of the four canonical statuses.
func isCanonical(s string) bool {
	for _, st := range statusOrder {
		if s == st {
			return true
		}
	}
	return false
}
