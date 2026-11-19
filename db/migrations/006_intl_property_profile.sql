-- Broker-facing property details that the AI reply must quote (address, district, rooms, listing,
-- brochure, plan, photos). SQLite gets these through store.js ensureColumn; Postgres needs them here,
-- otherwise saving a property on the pilot database fails with "column does not exist".
ALTER TABLE i_property ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE i_property ADD COLUMN IF NOT EXISTS district TEXT;
ALTER TABLE i_property ADD COLUMN IF NOT EXISTS bedrooms INTEGER;
ALTER TABLE i_property ADD COLUMN IF NOT EXISTS listing_url TEXT;
ALTER TABLE i_property ADD COLUMN IF NOT EXISTS brochure_url TEXT;
ALTER TABLE i_property ADD COLUMN IF NOT EXISTS plan_url TEXT;
ALTER TABLE i_property ADD COLUMN IF NOT EXISTS photos TEXT;
