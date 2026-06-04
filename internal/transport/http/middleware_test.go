package http

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func quietServer() *Server {
	return &Server{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func TestRecoverPanicReturns500(t *testing.T) {
	s := quietServer()
	h := s.recoverPanic(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

func TestRequestLoggerCapturesStatus(t *testing.T) {
	s := quietServer()
	h := s.requestLogger(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = io.WriteString(w, "no")
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))
	if rec.Code != http.StatusTeapot {
		t.Fatalf("status = %d, want 418", rec.Code)
	}
}

func TestLevelForStatus(t *testing.T) {
	cases := map[int]slog.Level{
		200: slog.LevelInfo,
		404: slog.LevelWarn,
		502: slog.LevelError,
	}
	for status, want := range cases {
		if got := levelForStatus(status); got != want {
			t.Errorf("levelForStatus(%d) = %v, want %v", status, got, want)
		}
	}
}
