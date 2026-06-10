-- Prevent duplicate workspaces for the same Telegram chat.
-- Idempotent: ADD CONSTRAINT has no IF NOT EXISTS, so guard with a catalog check
-- (the constraint may already exist from a manual run or an earlier deploy).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_chat_id_unique'
    ) THEN
        ALTER TABLE workspaces ADD CONSTRAINT workspaces_chat_id_unique UNIQUE (chat_id);
    END IF;
END$$;
