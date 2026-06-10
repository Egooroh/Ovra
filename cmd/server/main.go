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
	_ "time/tzdata" // embed the timezone database (alpine image has none)

	"ovra/internal/config"
	"ovra/internal/integrations/llm"
	"ovra/internal/integrations/yougile"
	"ovra/internal/queue"
	"ovra/internal/secret"
	"ovra/internal/service"
	"ovra/internal/storage"
	httptransport "ovra/internal/transport/http"
	"ovra/internal/worker"
	"ovra/migrations"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel()}))

	cfg, err := config.Load()
	if err != nil {
		log.Error("load config", "err", err)
		os.Exit(1)
	}
	log.Info("config loaded", "http_addr", cfg.HTTPAddr, "workspaces", len(cfg.Workspaces))

	// Connect to Postgres, apply migrations, and seed the tenant catalogue.
	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelStartup()

	repo, err := storage.Connect(startupCtx, cfg.DatabaseURL)
	if err != nil {
		log.Error("connect database", "err", err)
		os.Exit(1)
	}
	defer repo.Close()

	if err := storage.Migrate(startupCtx, repo.Pool(), migrations.FS); err != nil {
		log.Error("run migrations", "err", err)
		os.Exit(1)
	}
	log.Info("migrations applied")

	for _, ws := range cfg.Workspaces {
		if err := repo.UpsertWorkspace(startupCtx, ws); err != nil {
			log.Error("seed workspace", "id", ws.ID, "err", err)
			os.Exit(1)
		}
	}
	if n := len(cfg.Workspaces); n > 0 {
		log.Info("workspaces seeded", "count", n)
	}

	// Cipher for per-workspace secrets. Optional: without APP_SECRET the server
	// still serves /healthz, but the credentials endpoint will be unavailable.
	var cipher *secret.Cipher
	if c, err := secret.New(cfg.AppSecret); err != nil {
		log.Warn("APP_SECRET not set: YouGile credential storage disabled", "err", err)
	} else {
		cipher = c
	}

	// YouGile REST client (base URL overridable for testing/self-hosting).
	var ygOpts []yougile.Option
	if base := os.Getenv("YOUGILE_BASE_URL"); base != "" {
		ygOpts = append(ygOpts, yougile.WithBaseURL(base))
	}
	yg := yougile.New(ygOpts...)

	// Task publisher needs the cipher to decrypt per-workspace tokens; without
	// APP_SECRET it stays nil and POST /v1/tasks responds 503.
	var taskSvc *service.Tasks
	var tasks httptransport.TaskService
	if cipher != nil {
		taskSvc = service.NewTasks(repo, yg, cipher, cfg.DedupThreshold, log)
		tasks = taskSvc
	}

	// Event queue + worker: route task_create to the task service.
	q := queue.NewInMemory(256, log)
	router := worker.NewRouter(log)
	if taskSvc != nil {
		router.Register(worker.EventTaskCreate, worker.TaskCreateHandler(taskSvc))
	}
	q.Subscribe(router.Handle)
	defer q.Close()

	gateway := httptransport.NewServer(cfg, repo, cipher, yg, tasks, q, log)

	// Optional OpenRouter AI, shared by the column classifier and the dedup judge.
	// Disabled unless a key is set.
	if cfg.OpenRouterAPIKey != "" {
		ai := llm.New(llm.Config{
			APIKey:  cfg.OpenRouterAPIKey,
			Model:   cfg.OpenRouterModel,
			BaseURL: cfg.OpenRouterBaseURL,
		})
		gateway.SetClassifier(ai)
		if taskSvc != nil {
			taskSvc.SetDuplicateJudge(ai)
		}
		log.Info("openrouter ai enabled (column classifier + dedup judge)")
	}

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           gateway.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	// Run the server until an interrupt arrives, then shut down gracefully.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Background job: purge tasks that have been in the trash for > 24 h.
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				n, err := repo.DeleteExpiredTasks(context.Background())
				if err != nil {
					log.Error("trash cleanup", "err", err)
				} else if n > 0 {
					log.Info("trash cleanup", "deleted", n)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// Background job: auto-sync YouGile→Ovra every 5 minutes.
	// Tasks deleted in YouGile are soft-deleted in Ovra automatically.
	// On startup, runs once immediately to import any tasks already on the board.
	if cipher != nil {
		autoSyncer := service.NewAutoSyncer(repo, yg, cipher, cfg.BotInternalURL, cfg.WorkerSecret, log)
		go func() {
			autoSyncer.SyncAll(context.Background())
			ticker := time.NewTicker(5 * time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					autoSyncer.SyncAll(context.Background())
				case <-ctx.Done():
					return
				}
			}
		}()
		log.Info("auto-sync enabled (5 min interval)")
	}

	// Background job: daily task digest. Once a minute, check whether any
	// workspace's configured digest time has arrived and, if so, ask the bot to
	// post the digest. Requires the bot's internal URL.
	if cfg.BotInternalURL != "" {
		digest := service.NewDigestScheduler(repo, cfg.BotInternalURL, cfg.WorkerSecret, log)
		go func() {
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					digest.Tick(context.Background())
				case <-ctx.Done():
					return
				}
			}
		}()
		log.Info("digest scheduler enabled (1 min tick)")

		// Background job: deadline reminders. Every 5 minutes, DM assignees about
		// tasks due within 24 h (or overdue) that haven't been reminded yet.
		reminder := service.NewReminderScheduler(repo, cfg.BotInternalURL, cfg.WorkerSecret, log)
		go func() {
			ticker := time.NewTicker(5 * time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					reminder.Tick(context.Background())
				case <-ctx.Done():
					return
				}
			}
		}()
		log.Info("reminder scheduler enabled (5 min tick)")
	}

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
