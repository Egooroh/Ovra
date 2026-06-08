-- Per-workspace timezone for interpreting deadline times without an explicit TZ.
ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Europe/Moscow';
