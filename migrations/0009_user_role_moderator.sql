-- Add moderator role: can manage tasks (approve/reject/edit) but not workspace settings.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'moderator', 'member'));
