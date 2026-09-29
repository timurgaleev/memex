-- 088: runtime_config — DB-plane knob overrides (`memex config set|get|unset`).
--
-- A config table lets the engine merge overrides at connect time so an
-- operator can mutate ranking/behavior knobs without a redeploy. memex's knobs
-- are MEMEX_* env vars, so this stores env-shaped keys here and
-- Storage.init() overlays them onto process.env for keys the real environment
-- did NOT set — container env always wins, the DB plane fills the gaps. This
-- is also the substrate `memex search tune --apply` writes through.
--
-- Keys are constrained at the app layer to ^MEMEX_[A-Z0-9_]+$ (no PATH /
-- LD_PRELOAD injection surface); values are opaque text.

CREATE TABLE IF NOT EXISTS runtime_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
