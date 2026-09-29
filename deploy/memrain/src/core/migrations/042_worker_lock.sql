-- 042_worker_lock.sql — single-active-worker guard + heartbeat.
--
-- The queue's atomic claim (FOR UPDATE SKIP LOCKED) already keeps two workers
-- from claiming the SAME row, but nothing stops two worker PROCESSES (a
-- double-start, a second container, a restart overlap) from both polling and
-- both running the maintenance cycle. This singleton lock row elects ONE active
-- worker; the others idle until its heartbeat lapses (TTL), then a survivor
-- takes over. The same `heartbeat_at` doubles as wedge detection — a live but
-- stuck worker stops heartbeating, so `NOW() - heartbeat_at` going stale is the
-- signal (surfaced read-only via status; no auto-kill in this slice).
--
-- Uses only the plain query surface (no advisory locks — those are
-- session-scoped and die under a transaction pooler). Portable on PGLite + RDS.

CREATE TABLE IF NOT EXISTS worker_lock (
  id           TEXT PRIMARY KEY,
  holder       TEXT NOT NULL,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ttl_seconds  INTEGER NOT NULL DEFAULT 60
);
