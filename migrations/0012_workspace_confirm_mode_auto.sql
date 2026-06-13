-- Extend confirm_mode with a third value: 'auto'.
-- 'auto' — fully autonomous mode: tasks are created directly in YouGile with no
-- approval card. 'admin_only' and 'everyone' keep the existing approval flow.
--
-- The original CHECK from 0006 was added inline (auto-named, conventionally
-- workspaces_confirm_mode_check). Drop whichever check constraint references
-- confirm_mode — by definition, not by assumed name — then add the widened one.

DO $$
DECLARE
    cname text;
BEGIN
    SELECT conname INTO cname
    FROM pg_constraint
    WHERE conrelid = 'workspaces'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%confirm_mode%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE workspaces DROP CONSTRAINT %I', cname);
    END IF;
END $$;

ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_confirm_mode_check
        CHECK (confirm_mode IN ('admin_only', 'everyone', 'auto'));
