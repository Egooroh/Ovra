// Package domain holds the core business entities shared across layers.
// Phase 0 defines only what the config loader needs (Workspace); Task, User
// and Meeting are filled in during Phase 1 (storage).
package domain

// Columns maps the four MVP board states to YouGile column IDs.
type Columns struct {
	Todo       string `yaml:"todo"`
	InProgress string `yaml:"in_progress"`
	Review     string `yaml:"review"`
	Done       string `yaml:"done"`
}

// Workspace is a tenant: one Telegram chat bound to one YouGile project.
type Workspace struct {
	ID               string  `yaml:"id"`
	ChatID           string  `yaml:"chat_id"`
	Name             string  `yaml:"name"`
	YougileProjectID string  `yaml:"yougile_project_id"`
	Columns          Columns `yaml:"columns"`
	HostTgID         string  `yaml:"host_tg_id"`
}
