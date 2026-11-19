-- Shared inbox: owner invites a colleague by Telegram ID + one-time token.
CREATE TABLE IF NOT EXISTS i_team_member (
  owner_broker_id TEXT NOT NULL,
  member_telegram_id TEXT NOT NULL,
  role TEXT NOT NULL,
  invite_token_hash TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  PRIMARY KEY (owner_broker_id, member_telegram_id)
);

CREATE INDEX IF NOT EXISTS i_team_member_member
  ON i_team_member (member_telegram_id, status);

CREATE INDEX IF NOT EXISTS i_team_member_owner
  ON i_team_member (owner_broker_id, status);
