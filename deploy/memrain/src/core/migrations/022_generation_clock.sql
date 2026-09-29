-- 022_generation_clock.sql — cache-invalidation substrate.
--
-- Two counters power cheap cache-validity checks for the future query
-- cache: a per-page `generation` (bumped on every content change to that
-- page) and a global singleton `page_generation_clock` (bumped on every
-- page write). A cache entry records the clock value at write time; a
-- cheap `SELECT value FROM page_generation_clock` then tells a reader
-- whether ANY page changed since.
--
-- memex uses no DB triggers (every migration to date is plain portable
-- DDL); the bump is performed at the application layer inside the same
-- transaction as the page write — see core/generation.ts — so PGLite and
-- Postgres behave identically.

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS page_generation_clock (
  id     INTEGER PRIMARY KEY DEFAULT 1,
  value  BIGINT  NOT NULL DEFAULT 0,
  CONSTRAINT page_generation_clock_singleton CHECK (id = 1)
);

INSERT INTO page_generation_clock (id, value)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;
