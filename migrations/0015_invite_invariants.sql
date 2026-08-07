ALTER TABLE invite_code ADD COLUMN slot INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS invite_code_active_email
 ON invite_code(reserved_email) WHERE status = 'reserved' AND reserved_email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invite_code_creator_slot
 ON invite_code(creator_id, slot) WHERE slot IS NOT NULL;
