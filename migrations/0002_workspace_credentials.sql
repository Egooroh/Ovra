-- Phase 2 (B-05): per-workspace YouGile credentials.
-- The bot collects credentials during onboarding; the backend stores only the
-- API key, AES-GCM encrypted (BYTEA), never the password.

ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS yougile_login          TEXT  NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS yougile_api_token_enc  BYTEA;
