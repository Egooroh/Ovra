-- Per-task reminder bookkeeping: when the assignee was last nudged in PM about
-- an approaching/overdue deadline. NULL → never reminded yet.

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tasks_reminder
    ON tasks (tenant_id, deadline)
    WHERE reminded_at IS NULL AND deadline IS NOT NULL AND deleted_at IS NULL;
