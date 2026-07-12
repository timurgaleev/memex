-- 094: soft-delete column on oauth_clients.
--
-- OAuth clients are soft-deleted with a `deleted_at` timestamp and
-- filtered `WHERE deleted_at IS NULL` on every read; memex's oauth-provider
-- already probes for this column defensively (older brains lacked it), and the
-- admin observability endpoints (agents/spend, stats) filter on it. Add it so
-- the column is always present — NULL means active, which every existing row
-- is. Nullable, no backfill.
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
