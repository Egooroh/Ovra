-- confirm_mode controls who can approve/reject tasks in the group chat.
-- 'admin_only' (default) — only Telegram group administrators.
-- 'everyone'             — any group member.

ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS confirm_mode TEXT NOT NULL DEFAULT 'admin_only'
        CHECK (confirm_mode IN ('admin_only', 'everyone'));
