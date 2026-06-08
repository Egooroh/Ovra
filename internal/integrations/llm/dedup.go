package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"ovra/internal/domain"
)

// dedupSystemPrompt instructs the model to judge semantic task duplicates.
const dedupSystemPrompt = `Ты помощник проджект-менеджера. Тебе дают новую задачу и
список существующих задач с номерами. Определи, какие существующие задачи означают
ТО ЖЕ САМОЕ по смыслу, что новая, даже если сформулированы другими словами.
Ответь СТРОГО JSON-массивом номеров (0-based) подходящих существующих задач.
Если совпадений нет — верни []. Никаких пояснений, только JSON.`

// JudgeDuplicates implements service.DuplicateJudge: it returns the subset of
// candidates that mean the same task as (title, description).
func (c *Client) JudgeDuplicates(ctx context.Context, title, description string, candidates []domain.Task) ([]domain.Task, error) {
	if len(candidates) == 0 {
		return nil, nil
	}

	var sb strings.Builder
	for i, t := range candidates {
		fmt.Fprintf(&sb, "%d) %s\n", i, t.Title)
	}
	newTask := title
	if description != "" {
		newTask += " — " + description
	}
	user := fmt.Sprintf("Новая задача: %q\n\nСуществующие задачи:\n%s", newTask, sb.String())

	content, err := c.complete(ctx, dedupSystemPrompt, user)
	if err != nil {
		return nil, err
	}

	idxs, err := parseIndices(content)
	if err != nil {
		return nil, err
	}

	var out []domain.Task
	seen := make(map[int]bool)
	for _, i := range idxs {
		if i >= 0 && i < len(candidates) && !seen[i] {
			seen[i] = true
			out = append(out, candidates[i])
		}
	}
	return out, nil
}

// parseIndices parses a JSON array of integers from the model reply.
func parseIndices(content string) ([]int, error) {
	content = stripFences(strings.TrimSpace(content))
	var arr []int
	if err := json.Unmarshal([]byte(content), &arr); err != nil {
		return nil, fmt.Errorf("llm: dedup reply is not a JSON int array: %w", err)
	}
	return arr, nil
}
