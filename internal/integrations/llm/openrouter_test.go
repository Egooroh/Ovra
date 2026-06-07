package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClassifyParsesArray(t *testing.T) {
	var gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		// Reply with an OpenAI-shaped completion whose content is a JSON array.
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"[\"todo\",\"done\"]"}}]}`)
	}))
	defer srv.Close()

	c := New(Config{APIKey: "k", Model: "m", BaseURL: srv.URL})
	out, err := c.Classify(context.Background(), []string{"Бэклог", "Архив"})
	if err != nil {
		t.Fatalf("Classify: %v", err)
	}
	if len(out) != 2 || out[0] != "todo" || out[1] != "done" {
		t.Fatalf("out = %v", out)
	}
	if gotAuth != "Bearer k" {
		t.Fatalf("auth = %q", gotAuth)
	}
	// The user message carries the titles as a JSON array.
	var req map[string]any
	_ = json.Unmarshal([]byte(gotBody), &req)
	if req["model"] != "m" {
		t.Fatalf("model not sent: %v", req["model"])
	}
}

func TestClassifyToleratesCodeFences(t *testing.T) {
	// Model wraps the JSON array in a ```json code fence.
	content := "```json\n[\"in_progress\"]\n```"
	body, _ := json.Marshal(map[string]any{
		"choices": []map[string]any{{"message": map[string]any{"content": content}}},
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	c := New(Config{APIKey: "k", BaseURL: srv.URL})
	out, err := c.Classify(context.Background(), []string{"Делаем"})
	if err != nil {
		t.Fatalf("Classify: %v", err)
	}
	if len(out) != 1 || out[0] != "in_progress" {
		t.Fatalf("out = %v", out)
	}
}

func TestClassifyMissingKey(t *testing.T) {
	c := New(Config{})
	if _, err := c.Classify(context.Background(), []string{"x"}); err == nil {
		t.Fatal("expected error without API key")
	}
}

func TestClassifyHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := New(Config{APIKey: "bad", BaseURL: srv.URL})
	if _, err := c.Classify(context.Background(), []string{"x"}); err == nil {
		t.Fatal("expected error on 401")
	}
}
