// Command server is the Ovra backend entry point: it loads configuration,
// builds the dependency graph and starts the HTTP API gateway.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"ovra/internal/config"
	httptransport "ovra/internal/transport/http"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel()}))

	cfg, err := config.Load()
	if err != nil {
		log.Error("load config", "err", err)
		os.Exit(1)
	}
	log.Info("config loaded", "http_addr", cfg.HTTPAddr, "workspaces", len(cfg.Workspaces))

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           httptransport.NewServer(cfg, log).Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	// Run the server until an interrupt arrives, then shut down gracefully.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Info("http server listening", "addr", cfg.HTTPAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown", "err", err)
		os.Exit(1)
	}
}

// logLevel reads LOG_LEVEL (debug/info/warn/error), defaulting to info.
func logLevel() slog.Level {
	switch os.Getenv("LOG_LEVEL") {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
