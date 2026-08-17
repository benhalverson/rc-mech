CREATE TABLE driving_analysis (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owner(id),
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  car_id TEXT NOT NULL REFERENCES car(id),
  drive_session_id TEXT NOT NULL REFERENCES drive_session(id),
  race_video_id TEXT NOT NULL,
  race_window_start_ms INTEGER NOT NULL CHECK (race_window_start_ms >= 0),
  race_window_end_ms INTEGER NOT NULL,
  approved_track_map_version_id TEXT NOT NULL REFERENCES track_map_version(id),
  subject_seed_timestamp_ms INTEGER NOT NULL,
  subject_box_x REAL NOT NULL CHECK (subject_box_x >= 0 AND subject_box_x < 1),
  subject_box_y REAL NOT NULL CHECK (subject_box_y >= 0 AND subject_box_y < 1),
  subject_box_width REAL NOT NULL CHECK (subject_box_width > 0 AND subject_box_width <= 1),
  subject_box_height REAL NOT NULL CHECK (subject_box_height > 0 AND subject_box_height <= 1),
  source_layout_version TEXT NOT NULL CHECK (source_layout_version = 'fixed-track-view.v1'),
  source_layout_digest TEXT NOT NULL CHECK (length(source_layout_digest) = 64),
  source_width INTEGER NOT NULL CHECK (source_width > 0),
  source_height INTEGER NOT NULL CHECK (source_height > 0),
  workflow_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'awaiting-reidentification', 'completed',
      'failed', 'cancelled', 'deleting', 'deleted')
  ),
  stage TEXT NOT NULL DEFAULT 'preparation' CHECK (
    stage IN ('preparation', 'tracking', 'measurement', 'clip-rendering',
      'finalization')
  ),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    race_window_end_ms > race_window_start_ms AND
    race_window_end_ms - race_window_start_ms <= 900000
  ),
  CHECK (
    subject_seed_timestamp_ms >= race_window_start_ms AND
    subject_seed_timestamp_ms < race_window_end_ms
  ),
  CHECK (subject_box_x + subject_box_width <= 1),
  CHECK (subject_box_y + subject_box_height <= 1),
  CHECK (subject_box_width * subject_box_height >= 0.000000000001),
  CHECK (
    (status = 'queued' AND stage = 'preparation' AND progress = 0) OR
    (status = 'running' AND progress < 100) OR
    (status = 'awaiting-reidentification' AND stage = 'tracking' AND progress < 100) OR
    (status = 'completed' AND stage = 'finalization' AND progress = 100) OR
    status IN ('failed', 'cancelled', 'deleting', 'deleted')
  )
);

CREATE UNIQUE INDEX driving_analysis_owner_request_idx
  ON driving_analysis(owner_id, request_id);
CREATE INDEX driving_analysis_owner_drive_idx
  ON driving_analysis(owner_id, drive_session_id, created_at);

CREATE TRIGGER driving_analysis_owner_active_quota
BEFORE INSERT ON driving_analysis
BEGIN
  SELECT RAISE(ABORT, 'driving_analysis owner quota exceeded') WHERE (
    SELECT COUNT(*) FROM driving_analysis
    WHERE owner_id = NEW.owner_id
      AND status IN ('queued', 'running', 'awaiting-reidentification')
  ) >= 3;
END;

CREATE TRIGGER driving_analysis_initial_state
BEFORE INSERT ON driving_analysis
BEGIN
  SELECT RAISE(ABORT, 'driving_analysis must start queued for preparation')
  WHERE NEW.status != 'queued' OR NEW.stage != 'preparation' OR
    NEW.progress != 0 OR NEW.state_version != 1 OR
    NEW.workflow_id != NEW.id OR NEW.updated_at != NEW.created_at;
END;

CREATE TRIGGER driving_analysis_current_input
BEFORE INSERT ON driving_analysis
BEGIN
  SELECT RAISE(ABORT, 'driving_analysis Car or Drive session is unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM car
    INNER JOIN drive_session ON drive_session.car_id = car.id
    WHERE car.id = NEW.car_id AND car.owner_id = NEW.owner_id
      AND car.archived_at IS NULL
      AND drive_session.id = NEW.drive_session_id
      AND drive_session.deleted_at IS NULL
  );
  SELECT RAISE(ABORT, 'driving_analysis Race recording is not ready')
  WHERE NOT EXISTS (
    SELECT 1 FROM race_video
    INNER JOIN race_video_validation
      ON race_video_validation.race_video_id = race_video.id
    WHERE race_video.id = NEW.race_video_id
      AND race_video.owner_id = NEW.owner_id
      AND race_video.car_id = NEW.car_id
      AND race_video.drive_session_id = NEW.drive_session_id
      AND race_video.status = 'validating'
      AND race_video_validation.status = 'ready'
      AND race_video_validation.duration_ms >= NEW.race_window_end_ms
      AND race_video_validation.width = NEW.source_width
      AND race_video_validation.height = NEW.source_height
  );
  SELECT RAISE(ABORT, 'driving_analysis Track-map version is unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM track_map_version
    INNER JOIN track_layout ON track_layout.id = track_map_version.layout_id
    WHERE track_map_version.id = NEW.approved_track_map_version_id
      AND track_map_version.status = 'approved'
      AND track_layout.status = 'active'
  );
END;

CREATE TRIGGER driving_analysis_input_immutable
BEFORE UPDATE OF id, owner_id, request_id, request_digest, car_id,
  drive_session_id, race_video_id, race_window_start_ms, race_window_end_ms,
  approved_track_map_version_id, subject_seed_timestamp_ms, subject_box_x,
  subject_box_y, subject_box_width, subject_box_height, source_layout_version,
  source_layout_digest, source_width, source_height, workflow_id, created_at
ON driving_analysis
BEGIN
  SELECT RAISE(ABORT, 'driving_analysis input is immutable');
END;

CREATE TRIGGER driving_analysis_lifecycle_transition
BEFORE UPDATE ON driving_analysis
BEGIN
  SELECT RAISE(ABORT, 'driving_analysis revision conflict')
  WHERE NEW.state_version != OLD.state_version + 1;
  SELECT RAISE(ABORT, 'driving_analysis progress cannot decrease')
  WHERE NEW.progress < OLD.progress;
  SELECT RAISE(ABORT, 'driving_analysis stage cannot regress')
  WHERE CASE NEW.stage
    WHEN 'preparation' THEN 0 WHEN 'tracking' THEN 1
    WHEN 'measurement' THEN 2 WHEN 'clip-rendering' THEN 3
    WHEN 'finalization' THEN 4 END <
    CASE OLD.stage
    WHEN 'preparation' THEN 0 WHEN 'tracking' THEN 1
    WHEN 'measurement' THEN 2 WHEN 'clip-rendering' THEN 3
    WHEN 'finalization' THEN 4 END;
  SELECT RAISE(ABORT, 'driving_analysis terminal state is immutable')
  WHERE OLD.status = 'deleted';
  SELECT RAISE(ABORT, 'driving_analysis lifecycle transition is invalid')
  WHERE (OLD.status = 'queued' AND NEW.status NOT IN ('running', 'failed', 'cancelled', 'deleting'))
    OR (OLD.status = 'running' AND NEW.status NOT IN ('running', 'awaiting-reidentification', 'completed', 'failed', 'cancelled', 'deleting'))
    OR (OLD.status = 'awaiting-reidentification' AND NEW.status NOT IN ('running', 'cancelled', 'deleting'))
    OR (OLD.status IN ('completed', 'failed', 'cancelled') AND NEW.status != 'deleting')
    OR (OLD.status = 'deleting' AND NEW.status NOT IN ('deleting', 'deleted'));
END;
