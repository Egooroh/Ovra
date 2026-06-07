// Package llm provides an OpenRouter-backed implementation of the column
// Classifier (OpenAI-compatible chat completions API).
//
// It is inert until an API key is configured — main only builds it when
// OPENROUTER_API_KEY is set, so the rest of the system runs unchanged without
// AI. To enable the AI column fallback you only need to provide the key
// (and optionally the model); the request/response plumbing is complete.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	defaultBaseURL = "https://openrouter.ai/api/v1"
	defaultModel   = "openai/gpt-4o-mini"
)

// Config configures the OpenRouter client.
type Config struct {
	APIKey  string // OPENROUTER_API_KEY — the only thing you must provide
	Model   string // e.g. "openai/gpt-4o-mini"; empty → default
	BaseURL string // empty → https://openrouter.ai/api/v1
}

// Client calls OpenRouter's chat completions endpoint to classify column names.
type Client struct {
	cfg  Config
	http *http.Client
}

// New builds a Client, applying defaults for model and base URL.
func New(cfg Config) *Client {
	if cfg.BaseURL == "" {
		cfg.BaseURL = defaultBaseURL
	}
	if cfg.Model == "" {
		cfg.Model = defaultModel
	}
	return &Client{cfg: cfg, http: &http.Client{Timeout: 30 * time.Second}}
}

// systemPrompt instructs the model to return a strict JSON array aligned with
// the input titles.
const systemPrompt = `You map kanban board column names to a workflow status.
Allowed statuses: "todo", "in_progress", "review", "done".
You receive a JSON array of column names. Reply with ONLY a JSON array of the
same length and order, where each element is one of the allowed statuses, or an
empty string "" if a column does not correspond to any of them. No prose, no
code fences.`

// chat request/response shapes (OpenAI-compatible subset).
type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
}

// Classify implements columns.Classifier. It returns a status per input title,
// aligned by index; unknown titles get "".
func (c *Client) Classify(ctx context.Context, titles []string) ([]string, error) {
	if c.cfg.APIKey == "" {
		return nil, fmt.Errorf("llm: missing OPENROUTER_API_KEY")
	}
	if len(titles) == 0 {
		return nil, nil
	}

	titlesJSON, _ := json.Marshal(titles)
	reqBody, err := json.Marshal(chatRequest{
		Model:       c.cfg.Model,
		Temperature: 0,
		Messages: []chatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: string(titlesJSON)},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("llm: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST",
		c.cfg.BaseURL+"/chat/completions", bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("llm: new request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	// Optional OpenRouter attribution headers.
	req.Header.Set("HTTP-Referer", "https://github.com/Egooroh/Ovra")
	req.Header.Set("X-Title", "Ovra")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("llm: request: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("llm: status %d: %s", resp.StatusCode, string(body))
	}

	var cr chatResponse
	if err := json.Unmarshal(body, &cr); err != nil {
		return nil, fmt.Errorf("llm: decode response: %w", err)
	}
	if len(cr.Choices) == 0 {
		return nil, fmt.Errorf("llm: empty choices")
	}

	statuses, err := parseStatuses(cr.Choices[0].Message.Content, len(titles))
	if err != nil {
		return nil, err
	}
	return statuses, nil
}

// parseStatuses extracts a JSON string array from the model's reply (tolerating
// code fences) and normalises it to exactly n elements.
func parseStatuses(content string, n int) ([]string, error) {
	content = stripFences(strings.TrimSpace(content))
	var arr []string
	if err := json.Unmarshal([]byte(content), &arr); err != nil {
		return nil, fmt.Errorf("llm: reply is not a JSON array: %w", err)
	}
	out := make([]string, n)
	for i := 0; i < n && i < len(arr); i++ {
		out[i] = strings.ToLower(strings.TrimSpace(arr[i]))
	}
	return out, nil
}

// stripFences removes a surrounding ```json ... ``` block if present.
func stripFences(s string) string {
	if !strings.HasPrefix(s, "```") {
		return s
	}
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimPrefix(s, "json")
	s = strings.TrimSuffix(s, "```")
	return strings.TrimSpace(s)
}
