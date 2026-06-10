// Package domain holds the core business entities shared across layers.
package domain

import "time"

// Approval states for a task awaiting the host's decision.
const (
	ApprovalPending  = "pending"
	ApprovalApproved = "approved"
	ApprovalRejected = "rejected"
)

// User roles within a workspace.
const (
	RoleAdmin  = "admin"
	RoleMember = "member"
)

// Board statuses, aligned with the workspace columns.
const (
	StatusTodo       = "todo"
	StatusInProgress = "in_progress"
	StatusReview     = "review"
	StatusDone       = "done"
)

// Task sources.
const (
	SourceChat    = "chat"
	SourceMeeting = "meeting"
	SourceYougile = "yougile"
)

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
	// Timezone (IANA, e.g. "Europe/Moscow") used to interpret deadline times
	// that carry no timezone. Empty → global DEADLINE_TZ fallback.
	Timezone string `yaml:"timezone"`
	// Digest settings. DigestTime is "HH:MM" in the workspace timezone.
	DigestEnabled bool   `yaml:"digest_enabled"`
	DigestTime    string `yaml:"digest_time"`
	// ConfirmMode controls who can approve/reject tasks: "admin_only" or "everyone".
	ConfirmMode string `yaml:"confirm_mode"`
}

// User is a workspace member mapped to their YouGile account.
type User struct {
	ID            string
	TenantID      string
	TgID          string
	TgUsername    string
	FullName      string
	YougileUserID string
	Role          string // "admin" | "member"
}

// Task is a candidate or approved task; once approved it becomes a YouGile card.
// Pointer fields are nullable in the database.
type Task struct {
	ID             string
	TenantID       string
	Title          string
	Description    string
	AssigneeUserID *string
	Deadline       *time.Time
	Status         string
	ApprovalStatus string
	YougileTaskID  *string
	MeetingID      *string
	Source         string
	CreatedAt      time.Time
	UpdatedAt      time.Time
	DeletedAt      *time.Time // non-nil → in trash; physically removed after 24 h
}

// ReminderDue is a task whose deadline is approaching (or past) and whose
// assignee should be nudged in their private Telegram chat. It carries just the
// fields the reminder needs, joined from tasks + users.
type ReminderDue struct {
	TaskID       string
	TenantID     string
	Title        string
	Deadline     time.Time
	AssigneeTgID string // Telegram user id of the assignee
}

// Meeting is the source of meeting-derived tasks (transcript/summary).
type Meeting struct {
	ID          string
	TenantID    string
	Title       string
	MeetingURL  string
	Transcript  string
	Summary     string
	ScheduledAt *time.Time
	EndedAt     *time.Time
	Status      string
}
