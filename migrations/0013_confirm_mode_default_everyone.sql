-- Change the default task-confirmation mode to 'everyone' (manual approval,
-- everyone can approve). Previously new workspaces defaulted to 'admin_only'.
--
-- Also migrate existing rows still sitting at the old default 'admin_only' to
-- 'everyone'. The per-workspace toggle was only just introduced, so existing
-- 'admin_only' values are the old default rather than a deliberate choice; an
-- admin who wants admin-only approval can re-enable it from the Mini App.
-- 'everyone' and 'auto' rows are left untouched.

ALTER TABLE workspaces
    ALTER COLUMN confirm_mode SET DEFAULT 'everyone';

UPDATE workspaces
    SET confirm_mode = 'everyone'
    WHERE confirm_mode = 'admin_only';
