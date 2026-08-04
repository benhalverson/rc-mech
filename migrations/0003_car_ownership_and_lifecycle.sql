ALTER TABLE car ADD COLUMN owner_id TEXT REFERENCES owner(id);
ALTER TABLE car ADD COLUMN make TEXT;
ALTER TABLE car ADD COLUMN vehicle_type TEXT;
ALTER TABLE car ADD COLUMN power_type TEXT;

-- Keep cars created by the original scaffold readable in the database. They
-- have no owner and are intentionally not exposed through the owner-scoped API
-- until an explicit ownership-repair operation exists.
UPDATE car SET make = manufacturer WHERE make IS NULL;

CREATE INDEX IF NOT EXISTS car_owner_archived_created_idx
  ON car(owner_id, archived_at, created_at);
