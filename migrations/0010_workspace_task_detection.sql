ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS task_detection TEXT NOT NULL DEFAULT 'heuristic';
