-- 108_enrollment_spend_caps.sql — a daily spend cap per enrolled person.
--
-- A connector in enrollment mode serves several people, each in their own
-- source, but every token it issued spent under the connector's client id, so
-- the whole team shared one daily cap and one person could spend it for all.
-- A token redeemed from an enrollment code now remembers which enrollment it
-- came from (`grant_id`, carried code → access → refresh), spends under that
-- id, and is capped by the enrollment's own `budget_usd_per_day`; with none
-- set, the connector's cap applies to each person separately.
--
-- Additive; NULL everywhere for tokens issued before this or outside
-- enrollment, which keep spending under their client.
ALTER TABLE oauth_enrollments ADD COLUMN IF NOT EXISTS budget_usd_per_day NUMERIC(10, 2);
ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS grant_id TEXT;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS grant_id TEXT;
