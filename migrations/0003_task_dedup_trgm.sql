-- Phase: task deduplication (layers 1–2).
-- pg_trgm enables fuzzy title matching (similarity()); the GIN index keeps the
-- "find similar open tasks" query fast. pg_trgm is a trusted extension, so the
-- database owner can create it without superuser.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_tasks_title_trgm
    ON tasks USING gin (title gin_trgm_ops);
