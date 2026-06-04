-- Phase 1 (B-03): initial schema for the MVP.
-- Applied automatically on startup by the migration runner (storage.Migrate).

-- workspaces: a tenant — one Telegram chat bound to one YouGile project.
-- id is a human-assigned text key (matches workspace.yaml), so tenant_id
-- references stay readable and seeding from YAML is a straight upsert.
CREATE TABLE IF NOT EXISTS workspaces (
    id                 TEXT PRIMARY KEY,
    chat_id            TEXT NOT NULL,
    name               TEXT NOT NULL,
    yougile_project_id TEXT NOT NULL DEFAULT '',
    col_todo           TEXT NOT NULL DEFAULT '',
    col_in_progress    TEXT NOT NULL DEFAULT '',
    col_review         TEXT NOT NULL DEFAULT '',
    col_done           TEXT NOT NULL DEFAULT '',
    host_tg_id         TEXT NOT NULL DEFAULT ''
);

-- users: members of a workspace, mapped to their YouGile account.
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tg_id           TEXT NOT NULL,
    tg_username     TEXT NOT NULL DEFAULT '',
    full_name       TEXT NOT NULL DEFAULT '',
    yougile_user_id TEXT NOT NULL DEFAULT '',
    UNIQUE (tenant_id, tg_id)
);

-- meetings: source of meeting-derived tasks (filled by У2/У3 later).
CREATE TABLE IF NOT EXISTS meetings (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title        TEXT NOT NULL DEFAULT '',
    meeting_url  TEXT NOT NULL DEFAULT '',
    transcript   TEXT NOT NULL DEFAULT '',
    summary      TEXT NOT NULL DEFAULT '',
    scheduled_at TIMESTAMPTZ,
    ended_at     TIMESTAMPTZ,
    status       TEXT NOT NULL DEFAULT 'planned'
);

-- tasks: the core entity — a candidate or approved task that becomes a
-- YouGile card once the host approves it.
CREATE TABLE IF NOT EXISTS tasks (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    deadline         TIMESTAMPTZ,
    status           TEXT NOT NULL DEFAULT 'todo',
    approval_status  TEXT NOT NULL DEFAULT 'pending',
    yougile_task_id  TEXT,
    meeting_id       UUID REFERENCES meetings(id) ON DELETE SET NULL,
    source           TEXT NOT NULL DEFAULT 'chat',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant   ON tasks (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_approval ON tasks (tenant_id, approval_status);
CREATE INDEX IF NOT EXISTS idx_users_tenant   ON users (tenant_id);
