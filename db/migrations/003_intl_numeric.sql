-- Databases created from the INTEGER draft of 002_intl.sql already recorded that
-- filename, so the new column types never applied. This alters them in place.
ALTER TABLE i_property
  ALTER COLUMN price TYPE DOUBLE PRECISION,
  ALTER COLUMN area_value TYPE DOUBLE PRECISION;

ALTER TABLE i_lead
  ALTER COLUMN budget_amount TYPE DOUBLE PRECISION;
