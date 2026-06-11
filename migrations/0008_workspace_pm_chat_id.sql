-- Per-workspace PM chat id: the private chat that receives task confirmation cards.
-- Previously a runtime variable in the bot; now persisted so it survives restarts.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS pm_chat_id TEXT NOT NULL DEFAULT '';
