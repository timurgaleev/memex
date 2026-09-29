-- 093: chunk_source provenance on chunks — how a chunk was derived.
--
-- Populated for fenced-code chunks extracted from a markdown page
-- (`chunk_source = 'fenced_code'`) so a ```lang code example ranks as code and
-- can be distinguished from the surrounding prose. NULL for ordinary markdown
-- prose chunks and whole-file code chunks (their provenance is implicit in the
-- document's source_path / kind). Nullable, no backfill — existing rows read as
-- "not a fenced extraction", which is correct.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunk_source TEXT;
