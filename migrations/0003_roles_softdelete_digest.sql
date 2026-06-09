-- Role per user (admin can confirm/reject tasks), soft-delete for tasks (trash),
-- and per-workspace digest settings.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('admin', 'member'));

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tasks_deleted
    ON tasks (tenant_id, deleted_at)
    WHERE deleted_at IS NOT NULL;

ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS digest_time TEXT NOT NULL DEFAULT '09:00';
