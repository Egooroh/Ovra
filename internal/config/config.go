// Package config loads runtime configuration from the environment and the
// workspace catalogue (workspace.yaml). It is the single source of truth that
// main.go wires into the rest of the app.
package config

import (
	"fmt"
	"os"
	"strconv"

	"gopkg.in/yaml.v3"

	"ovra/internal/domain"
)

// Config is the assembled runtime configuration.
type Config struct {
	// HTTPAddr is the listen address for the API gateway, e.g. ":8080".
	HTTPAddr string
	// DatabaseURL is the Postgres DSN (used from Phase 1 onward).
	DatabaseURL string
	// YougileAPIToken is an optional global fallback token (used only when a
	// workspace has no per-tenant token of its own).
	YougileAPIToken string
	// AppSecret is the passphrase that encrypts per-workspace secrets at rest.
	AppSecret string
	// OpenRouter* configure the optional AI column classifier. When the API key
	// is empty the classifier is disabled and the resolver uses dictionary +
	// ordinal only.
	OpenRouterAPIKey  string
	OpenRouterModel   string
	OpenRouterBaseURL string
	// DedupThreshold is the pg_trgm similarity (0..1) above which a new task is
	// treated as a possible duplicate. <= 0 disables deduplication.
	DedupThreshold float64
	// WorkerSecret is the shared token the TS meeting-worker includes in
	// Authorization: Bearer <token> when POSTing to /v1/meetings/summary.
	// Empty → auth is skipped (dev/testing only).
	WorkerSecret string
	// BotSecret is the shared token that the Telegram bot includes in
	// Authorization: Bearer <token> for every /v1/* mutating request.
	// Empty → auth is skipped (dev/testing only).
	BotSecret string
	// MeetingWorkerURL is the base URL of the TS meeting-worker management API,
	// e.g. http://meeting-worker:3001. Used to forward Telemost links for scheduling.
	// Empty → the /v1/workspaces/{tenant}/calls endpoint returns 503.
	MeetingWorkerURL string
	// BotInternalURL is the base URL of the Telegram bot's internal HTTP server,
	// e.g. http://bot:3000. When set, meeting summaries are forwarded there for
	// per-task user confirmation instead of being auto-created in YouGile.
	// Empty → tasks are created automatically (legacy behaviour).
	BotInternalURL string
	// TelegramBotToken is the bot's token (used to verify Telegram Mini App
	// initData via HMAC-SHA256).  Required for the /miniapp/* endpoints.
	TelegramBotToken string
	// MiniAppURL is the public HTTPS URL of the Telegram Mini App, e.g.
	// https://your-domain.com/miniapp/.  The bot sends this URL as a web_app
	// button; it must be HTTPS for Telegram to accept it.  Empty → the bot
	// falls back to the deep-link flow only.
	MiniAppURL string
	// Workspaces is the tenant catalogue loaded from workspace.yaml.
	Workspaces []domain.Workspace
}

// workspaceFile is the on-disk shape of workspace.yaml.
type workspaceFile struct {
	Workspaces []domain.Workspace `yaml:"workspaces"`
}

// Load reads environment variables and the workspace catalogue. The path to the
// catalogue defaults to WORKSPACE_CONFIG or "workspace.yaml".
func Load() (*Config, error) {
	cfg := &Config{
		HTTPAddr:        env("HTTP_ADDR", ":8080"),
		DatabaseURL:     env("DATABASE_URL", "postgres://ovra:ovra@localhost:5433/ovra?sslmode=disable"),
		YougileAPIToken:   os.Getenv("YOUGILE_API_TOKEN"),
		AppSecret:         os.Getenv("APP_SECRET"),
		OpenRouterAPIKey:  os.Getenv("OPENROUTER_API_KEY"),
		OpenRouterModel:   os.Getenv("OPENROUTER_MODEL"),
		OpenRouterBaseURL: os.Getenv("OPENROUTER_BASE_URL"),
		DedupThreshold:   envFloat("DEDUP_SIMILARITY", 0.4),
		WorkerSecret:     os.Getenv("WORKER_SECRET"),
		BotSecret:        os.Getenv("BOT_SECRET"),
		MeetingWorkerURL: os.Getenv("MEETING_WORKER_URL"),
		BotInternalURL:   os.Getenv("BOT_INTERNAL_URL"),
		TelegramBotToken: os.Getenv("TELEGRAM_BOT_TOKEN"),
		MiniAppURL:       os.Getenv("MINI_APP_URL"),
	}

	wsPath := env("WORKSPACE_CONFIG", "workspace.yaml")
	workspaces, err := loadWorkspaces(wsPath)
	if err != nil {
		return nil, fmt.Errorf("load workspaces: %w", err)
	}
	cfg.Workspaces = workspaces

	return cfg, nil
}

// loadWorkspaces parses the workspace catalogue. A missing file is not fatal in
// Phase 0 (the gateway can still boot and serve /healthz with no tenants).
func loadWorkspaces(path string) ([]domain.Workspace, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}

	var wf workspaceFile
	if err := yaml.Unmarshal(data, &wf); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}

	for i, ws := range wf.Workspaces {
		if ws.ID == "" {
			return nil, fmt.Errorf("workspace #%d in %s has empty id", i, path)
		}
	}
	return wf.Workspaces, nil
}

// WorkspaceByID returns the workspace with the given tenant id, or false.
func (c *Config) WorkspaceByID(id string) (domain.Workspace, bool) {
	for _, ws := range c.Workspaces {
		if ws.ID == id {
			return ws, true
		}
	}
	return domain.Workspace{}, false
}

// env returns the value of key, or def when unset/empty.
func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envFloat parses key as a float, returning def when unset or invalid.
func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}
