ALTER TABLE drive_session ADD COLUMN deleted_at TEXT;
ALTER TABLE owner ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';

CREATE INDEX IF NOT EXISTS drive_session_car_deleted_started_idx
  ON drive_session(car_id, deleted_at, started_at);
