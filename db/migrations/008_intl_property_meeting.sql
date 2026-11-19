-- Viewing logistics fields used by the property form and INSERT/UPDATE in addProperty.
-- SQLite already adds these via store.js ensureColumn; Postgres pilot DBs created from
-- 002/006 did not have them, so POST /v1/intl/properties failed with "column does not exist".
ALTER TABLE i_property ADD COLUMN IF NOT EXISTS meeting_point TEXT;
ALTER TABLE i_property ADD COLUMN IF NOT EXISTS access_notes TEXT;
