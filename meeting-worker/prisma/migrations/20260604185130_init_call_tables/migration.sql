-- Initial schema for the meeting-assistant worker.
-- Idempotent guards per project convention.

DO $$ BEGIN
  CREATE TYPE "CallStatus" AS ENUM (
    'SCHEDULED', 'CLAIMED', 'JOINING', 'IN_CALL', 'ENDING', 'DONE', 'FAILED', 'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Call" (
  "id"          TEXT PRIMARY KEY,
  "sourceId"    TEXT NOT NULL,
  "joinUrl"     TEXT NOT NULL,
  "title"       TEXT,
  "startsAt"    TIMESTAMP(3) NOT NULL,
  "endsAt"      TIMESTAMP(3),
  "status"      "CallStatus" NOT NULL DEFAULT 'SCHEDULED',
  "workerPid"   INTEGER,
  "claimedAt"   TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "joinedAt"    TIMESTAMP(3),
  "endedAt"     TIMESTAMP(3),
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "lastError"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "Call_sourceId_key" ON "Call"("sourceId");
CREATE INDEX IF NOT EXISTS "Call_status_startsAt_idx" ON "Call"("status", "startsAt");
CREATE INDEX IF NOT EXISTS "Call_heartbeatAt_idx" ON "Call"("heartbeatAt");

CREATE TABLE IF NOT EXISTS "Transcript" (
  "id"        TEXT PRIMARY KEY,
  "callId"    TEXT NOT NULL,
  "fullText"  TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "Transcript_callId_key" ON "Transcript"("callId");

CREATE TABLE IF NOT EXISTS "TranscriptSegment" (
  "id"           TEXT PRIMARY KEY,
  "transcriptId" TEXT NOT NULL,
  "startMs"      INTEGER NOT NULL,
  "endMs"        INTEGER NOT NULL,
  "text"         TEXT NOT NULL,
  "speaker"      TEXT,
  "isFinal"      BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "TranscriptSegment_transcriptId_startMs_idx"
  ON "TranscriptSegment"("transcriptId", "startMs");

DO $$ BEGIN
  ALTER TABLE "Transcript"
    ADD CONSTRAINT "Transcript_callId_fkey"
    FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "TranscriptSegment"
    ADD CONSTRAINT "TranscriptSegment_transcriptId_fkey"
    FOREIGN KEY ("transcriptId") REFERENCES "Transcript"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
