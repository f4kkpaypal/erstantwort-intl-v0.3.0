-- One active viewing per (lead_id, slot_id). Atomic booking relies on this index
-- to make a repeated book return the existing reservation instead of inserting a
-- second row. The index is partial so cancelled viewings do not block a re-book.
-- Existing databases may contain duplicates from the pre-atomic booking path:
-- keep a confirmed row over an unconfirmed duplicate, then keep the oldest
-- remaining active row and drop the rest before the index is created.

DELETE FROM i_viewing u
USING i_viewing c
WHERE u.status = 'unconfirmed'
  AND c.status = 'confirmed'
  AND u.lead_id = c.lead_id
  AND u.slot_id = c.slot_id
  AND u.ctid <> c.ctid;

DELETE FROM i_viewing a
USING i_viewing b
WHERE a.lead_id = b.lead_id
  AND a.slot_id = b.slot_id
  AND a.status <> 'cancelled'
  AND b.status <> 'cancelled'
  AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS i_viewing_lead_slot_active
  ON i_viewing (lead_id, slot_id)
  WHERE status <> 'cancelled';
