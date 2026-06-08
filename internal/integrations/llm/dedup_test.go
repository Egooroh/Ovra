package llm

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"ovra/internal/domain"
)

func TestJudgeDuplicatesPicksMatches(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Model says candidate #1 is the same task.
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"[1]"}}]}`)
	}))
	defer srv.Close()

	c := New(Config{APIKey: "k", BaseURL: srv.URL})
	cands := []domain.Task{
		{ID: "a", Title: "Сверстать лендинг"},
		{ID: "b", Title: "Починить вход"},
	}
	out, err := c.JudgeDuplicates(context.Background(), "Исправить авторизацию", "", cands)
	if err != nil {
		t.Fatalf("JudgeDuplicates: %v", err)
	}
	if len(out) != 1 || out[0].ID != "b" {
		t.Fatalf("out = %+v, want [b]", out)
	}
}

func TestJudgeDuplicatesNoneAndOutOfRange(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Empty + an out-of-range index must be ignored safely.
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"[9]"}}]}`)
	}))
	defer srv.Close()

	c := New(Config{APIKey: "k", BaseURL: srv.URL})
	out, err := c.JudgeDuplicates(context.Background(), "x", "", []domain.Task{{ID: "a", Title: "t"}})
	if err != nil {
		t.Fatalf("JudgeDuplicates: %v", err)
	}
	if len(out) != 0 {
		t.Fatalf("out = %+v, want empty", out)
	}
}

func TestJudgeDuplicatesEmptyCandidates(t *testing.T) {
	c := New(Config{APIKey: "k", BaseURL: "http://unused"})
	out, err := c.JudgeDuplicates(context.Background(), "x", "", nil)
	if err != nil || out != nil {
		t.Fatalf("out=%v err=%v; want nil,nil", out, err)
	}
}
