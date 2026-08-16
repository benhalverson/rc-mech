CREATE TABLE tracking_run_input (
  run_id TEXT PRIMARY KEY REFERENCES tracking_run(id),
  owner_id TEXT NOT NULL,
  race_video_id TEXT NOT NULL,
  source_object_key TEXT NOT NULL,
  source_byte_count INTEGER NOT NULL CHECK (source_byte_count > 0),
  source_checksum TEXT NOT NULL CHECK (length(source_checksum) = 64),
  window_start_timestamp_ms INTEGER NOT NULL,
  window_end_timestamp_ms INTEGER NOT NULL,
  approved_track_map_version_id TEXT NOT NULL,
  source_layout_version TEXT NOT NULL,
  source_layout_digest TEXT NOT NULL CHECK (length(source_layout_digest) = 64),
  source_width INTEGER NOT NULL CHECK (source_width > 0),
  source_height INTEGER NOT NULL CHECK (source_height > 0),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  created_at TEXT NOT NULL,
  CHECK (window_end_timestamp_ms > window_start_timestamp_ms)
);

CREATE INDEX tracking_run_input_owner
  ON tracking_run_input(owner_id, run_id);

CREATE UNIQUE INDEX prepared_tracking_media_identity
  ON prepared_tracking_media(id, run_id);

CREATE TABLE prepared_tracking_object (
  prepared_media_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('prepared-media', 'frame-manifest')),
  object_key TEXT NOT NULL UNIQUE,
  byte_count INTEGER NOT NULL CHECK (byte_count > 0),
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  content_type TEXT NOT NULL,
  content_encoding TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (prepared_media_id, role),
  FOREIGN KEY (prepared_media_id, run_id)
    REFERENCES prepared_tracking_media(id, run_id),
  CHECK (
    (role = 'prepared-media' AND content_type = 'video/mp4' AND content_encoding IS NULL) OR
    (role = 'frame-manifest' AND content_type = 'application/vnd.rc-mech.prepared-frame-manifest+json' AND content_encoding = 'gzip')
  )
);

CREATE INDEX prepared_tracking_object_run
  ON prepared_tracking_object(run_id);

CREATE TABLE prepared_tracking_retention (
  run_id TEXT PRIMARY KEY REFERENCES tracking_run(id),
  prepared_media_id TEXT NOT NULL UNIQUE REFERENCES prepared_tracking_media(id),
  delete_after TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'active' AND deleted_at IS NULL) OR
    (state = 'deleted' AND deleted_at IS NOT NULL)
  )
);

CREATE INDEX prepared_tracking_retention_cleanup
  ON prepared_tracking_retention(state, delete_after);

CREATE TRIGGER tracking_run_input_immutable_update
BEFORE UPDATE ON tracking_run_input
BEGIN
  SELECT RAISE(ABORT, 'tracking_run_input is immutable');
END;

CREATE TRIGGER tracking_run_input_immutable_delete
BEFORE DELETE ON tracking_run_input
BEGIN
  SELECT RAISE(ABORT, 'tracking_run_input is immutable');
END;

CREATE TRIGGER prepared_tracking_object_immutable_update
BEFORE UPDATE ON prepared_tracking_object
BEGIN
  SELECT RAISE(ABORT, 'prepared_tracking_object is immutable');
END;

CREATE TRIGGER prepared_tracking_object_immutable_delete
BEFORE DELETE ON prepared_tracking_object
BEGIN
  SELECT RAISE(ABORT, 'prepared_tracking_object is immutable');
END;

CREATE TRIGGER prepared_tracking_retention_identity_immutable
BEFORE UPDATE OF run_id, prepared_media_id, delete_after, created_at
ON prepared_tracking_retention
BEGIN
  SELECT RAISE(ABORT, 'prepared_tracking_retention identity is immutable');
END;

CREATE TRIGGER prepared_tracking_retention_monotonic
BEFORE UPDATE ON prepared_tracking_retention
WHEN OLD.state <> 'active'
  OR NEW.state <> 'deleted'
  OR NEW.deleted_at IS NULL
  OR NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'prepared_tracking_retention transition is invalid');
END;

CREATE TRIGGER prepared_tracking_retention_immutable_delete
BEFORE DELETE ON prepared_tracking_retention
BEGIN
  SELECT RAISE(ABORT, 'prepared_tracking_retention is immutable');
END;
