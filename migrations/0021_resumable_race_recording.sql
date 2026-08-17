CREATE TABLE race_video (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner(id),
  car_id TEXT NOT NULL REFERENCES car(id),
  drive_session_id TEXT NOT NULL UNIQUE REFERENCES drive_session(id),
  request_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  multipart_upload_id TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  declared_size INTEGER NOT NULL CHECK (
    declared_size > 0 AND declared_size <= 10737418240
  ),
  actual_size INTEGER,
  part_size INTEGER NOT NULL CHECK (part_size = 10485760),
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (
    status IN ('uploading', 'completing', 'validating', 'deleting')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status IN ('uploading', 'completing') AND completed_at IS NULL AND actual_size IS NULL) OR
    (status = 'validating' AND completed_at IS NOT NULL AND actual_size = declared_size) OR
    status = 'deleting'
  )
);

CREATE INDEX race_video_owner_status
  ON race_video(owner_id, status, expires_at);

CREATE UNIQUE INDEX race_video_owner_request
  ON race_video(owner_id, request_id);

CREATE TABLE race_video_upload_part (
  race_video_id TEXT NOT NULL REFERENCES race_video(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (
    part_number > 0 AND part_number <= 10000
  ),
  transfer_request_id TEXT,
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (
    status IN ('uploading', 'uploaded', 'recoverable')
  ),
  claim_id TEXT,
  claim_transfer_request_id TEXT,
  etag TEXT,
  byte_count INTEGER NOT NULL CHECK (byte_count > 0),
  claimed_at TEXT,
  uploaded_at TEXT,
  PRIMARY KEY (race_video_id, part_number),
  UNIQUE (race_video_id, transfer_request_id),
  UNIQUE (race_video_id, claim_transfer_request_id),
  CHECK (
    (status = 'uploading' AND claim_id IS NOT NULL AND
      claim_transfer_request_id IS NOT NULL AND claimed_at IS NOT NULL) OR
    (status = 'uploaded' AND transfer_request_id IS NOT NULL AND
      claim_id IS NULL AND claim_transfer_request_id IS NULL AND
      etag IS NOT NULL AND uploaded_at IS NOT NULL) OR
    (status = 'recoverable' AND claim_id IS NULL AND
      claim_transfer_request_id IS NULL)
  )
);

CREATE TRIGGER race_video_identity_immutable
BEFORE UPDATE OF owner_id, car_id, drive_session_id, object_key,
  multipart_upload_id, request_id, file_name, content_type, declared_size,
  part_size, created_at
ON race_video
BEGIN
  SELECT RAISE(ABORT, 'race_video identity is immutable');
END;

CREATE TRIGGER race_video_owner_quota
BEFORE INSERT ON race_video
BEGIN
  SELECT RAISE(ABORT, 'race_video owner quota exceeded') WHERE (
    SELECT COUNT(*) FROM race_video
    WHERE owner_id = NEW.owner_id AND status IN ('uploading', 'completing')
  ) >= 2;
  SELECT RAISE(ABORT, 'race_video owner quota exceeded') WHERE COALESCE((
    SELECT SUM(declared_size) FROM race_video
    WHERE owner_id = NEW.owner_id AND status IN ('uploading', 'completing')
  ), 0) + NEW.declared_size > 21474836480;
  SELECT RAISE(ABORT, 'race_video owner quota exceeded') WHERE COALESCE((
    SELECT SUM(declared_size) FROM race_video
    WHERE owner_id = NEW.owner_id
  ), 0) + NEW.declared_size > 107374182400;
END;
