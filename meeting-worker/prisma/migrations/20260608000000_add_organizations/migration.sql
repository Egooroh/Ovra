-- Multi-tenant support: per-organization calendar accounts + tenant tag on Call.
-- Idempotent guards per project convention.

CREATE TABLE IF NOT EXISTS "CalendarAccount" (
  "id"             TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "provider"       TEXT NOT NULL,
  "label"          TEXT,
  "credentials"    TEXT NOT NULL,
  "calendarIds"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "active"         BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "CalendarAccount_organizationId_active_idx"
  ON "CalendarAccount"("organizationId", "active");

-- Tenant tag on Call. Nullable so existing rows and the single-tenant env
-- path keep working (downstream falls back to BACKEND_TENANT_ID).
ALTER TABLE "Call" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

CREATE INDEX IF NOT EXISTS "Call_organizationId_status_idx"
  ON "Call"("organizationId", "status");
