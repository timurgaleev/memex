-- memex schema migration 013: recipe-scoped KV state.
--
-- Recipes that poll external systems (gmail, gcal, …) need durable
-- state across container restarts: the cursor of the last successful
-- poll, a bounded dedup set of recently-seen ids, etc. Keeping a
-- single KV table per recipe avoids one bespoke schema per recipe
-- driver while staying portable across PGLite + Postgres.
--
-- Shape: (recipe_id, key) is the natural primary key. `value` is JSONB
-- so callers can stash arbitrary structures (cursor object, id set
-- with timestamp, etc) without schema migrations per addition.

CREATE TABLE IF NOT EXISTS recipe_state (
  recipe_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (recipe_id, key)
);

CREATE INDEX IF NOT EXISTS recipe_state_recipe_idx ON recipe_state(recipe_id);
