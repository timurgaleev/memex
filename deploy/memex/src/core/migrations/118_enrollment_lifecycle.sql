-- 118_enrollment_lifecycle.sql — replacement codes and an enrollment audit trail.
--
-- A person who lost her connector (new laptop, new chat account) needs a fresh
-- enrollment code, but her spend so far is booked under her old enrollment's
-- id. A replacement code carries that id forward:
--   spend_id     the key the person spends under; NULL = the enrollment's own id.
--                A replacement copies its predecessor's key, so the day's spend
--                and the cap keep counting in one place.
--   replaces_id  the enrollment this one replaces; redeeming it revokes that one.
--
-- oauth_enrollment_audit records who issued, revoked or replaced a code, the
-- way oauth_grant_audit records client grant changes. It has no FK on purpose:
-- the history must outlive the rows it describes.
--
-- Additive; every existing enrollment keeps spending under its own id.
ALTER TABLE oauth_enrollments ADD COLUMN IF NOT EXISTS spend_id TEXT;
ALTER TABLE oauth_enrollments ADD COLUMN IF NOT EXISTS replaces_id TEXT;

CREATE INDEX IF NOT EXISTS idx_oauth_enrollments_spend_id
  ON oauth_enrollments (spend_id) WHERE spend_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_enrollment_audit (
  id             BIGSERIAL PRIMARY KEY,
  enrollment_id  TEXT NOT NULL,
  client_id      TEXT NULL,
  action         TEXT NOT NULL,
  actor          TEXT NOT NULL,
  via            TEXT NOT NULL CHECK (via IN ('cli', 'admin_api', 'enrollment')),
  before         JSONB NULL,
  after          JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_enrollment_audit_enrollment
  ON oauth_enrollment_audit (enrollment_id, created_at DESC);
