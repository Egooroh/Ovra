// Package config loads runtime configuration from the environment and the
// workspace catalogue (workspace.yaml). It is the single source of truth that
// main.go wires into the rest of the app.
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"

	"ovra/internal/domain"
)

// Config is the assembled runtime configuration.
type Config struct {
	// HTTPAddr is the listen address for the API gateway, e.g. ":8080".
	HTTPAddr string
	// DatabaseURL is the Postgres DSN (used from Phase 1 onward).
	DatabaseURL string
	// YougileAPIToken authenticates the YouGile REST client (Phase 2).
	YougileAPIToken string
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
		DatabaseURL:     env("DATABASE_URL", "postgres://ovra:ovra@localhost:5432/ovra?sslmode=disable"),
		YougileAPIToken: os.Getenv("YOUGILE_API_TOKEN"),
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
