-- Broker scope + follow-ups for intl desk
ALTER TABLE i_property ADD COLUMN IF NOT EXISTS broker_id TEXT;

CREATE TABLE IF NOT EXISTS i_followup (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  broker_id TEXT,
  due_at TEXT NOT NULL,
  kind TEXT,
  note TEXT,
  status TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS i_followup_due ON i_followup (status, due_at);
CREATE INDEX IF NOT EXISTS i_property_broker ON i_property (broker_id);
