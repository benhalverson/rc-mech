CREATE TABLE race_video_validation (
  race_video_id TEXT PRIMARY KEY REFERENCES race_video(id) ON DELETE CASCADE,
  validation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'ready', 'invalid')
  ),
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  byte_count INTEGER,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  video_codec TEXT,
  audio_codecs_json TEXT,
  container_formats_json TEXT,
  decoded_frame_count INTEGER,
  average_frame_rate_numerator INTEGER,
  average_frame_rate_denominator INTEGER,
  time_base_numerator INTEGER,
  time_base_denominator INTEGER,
  sample_aspect_ratio_numerator INTEGER,
  sample_aspect_ratio_denominator INTEGER,
  display_aspect_ratio_numerator INTEGER,
  display_aspect_ratio_denominator INTEGER,
  start_time_ms INTEGER,
  checksum_sha256 TEXT,
  error_code TEXT,
  error_stage TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (status = 'pending' AND completed_at IS NULL AND
      byte_count IS NULL AND duration_ms IS NULL AND width IS NULL AND
      height IS NULL AND video_codec IS NULL AND audio_codecs_json IS NULL AND
      container_formats_json IS NULL AND decoded_frame_count IS NULL AND
      average_frame_rate_numerator IS NULL AND
      average_frame_rate_denominator IS NULL AND time_base_numerator IS NULL AND
      time_base_denominator IS NULL AND sample_aspect_ratio_numerator IS NULL AND
      sample_aspect_ratio_denominator IS NULL AND
      display_aspect_ratio_numerator IS NULL AND
      display_aspect_ratio_denominator IS NULL AND start_time_ms IS NULL AND
      checksum_sha256 IS NULL AND error_code IS NULL AND error_stage IS NULL AND
      error_message IS NULL) OR
    (status = 'ready' AND completed_at IS NOT NULL AND byte_count > 0 AND
      duration_ms > 0 AND width > 0 AND height > 0 AND
      length(video_codec) BETWEEN 1 AND 32 AND audio_codecs_json IS NOT NULL AND
      container_formats_json IS NOT NULL AND decoded_frame_count > 0 AND
      average_frame_rate_denominator > 0 AND time_base_denominator > 0 AND
      sample_aspect_ratio_denominator > 0 AND
      display_aspect_ratio_denominator > 0 AND
      length(checksum_sha256) = 64 AND error_code IS NULL AND
      error_stage IS NULL AND error_message IS NULL) OR
    (status = 'invalid' AND completed_at IS NOT NULL AND
      byte_count IS NULL AND duration_ms IS NULL AND width IS NULL AND
      height IS NULL AND video_codec IS NULL AND audio_codecs_json IS NULL AND
      container_formats_json IS NULL AND decoded_frame_count IS NULL AND
      average_frame_rate_numerator IS NULL AND
      average_frame_rate_denominator IS NULL AND time_base_numerator IS NULL AND
      time_base_denominator IS NULL AND sample_aspect_ratio_numerator IS NULL AND
      sample_aspect_ratio_denominator IS NULL AND
      display_aspect_ratio_numerator IS NULL AND
      display_aspect_ratio_denominator IS NULL AND start_time_ms IS NULL AND
      checksum_sha256 IS NULL AND length(error_code) BETWEEN 1 AND 64 AND
      length(error_stage) BETWEEN 1 AND 32 AND
      length(error_message) BETWEEN 1 AND 160)
  )
);

CREATE INDEX race_video_validation_status
  ON race_video_validation(status, updated_at);

CREATE TRIGGER race_video_validation_parent_current_on_insert
BEFORE INSERT ON race_video_validation
BEGIN
  SELECT RAISE(ABORT, 'race_video_validation source is not current')
  WHERE NOT EXISTS (
    SELECT 1 FROM race_video
    WHERE id = NEW.race_video_id AND status = 'validating'
  );
END;

CREATE TRIGGER race_video_validation_identity_immutable
BEFORE UPDATE OF race_video_id, validation_id, started_at
ON race_video_validation
BEGIN
  SELECT RAISE(ABORT, 'race_video_validation identity is immutable');
END;

CREATE TRIGGER race_video_validation_transition
BEFORE UPDATE ON race_video_validation
BEGIN
  SELECT RAISE(ABORT, 'race_video_validation revision conflict')
  WHERE NEW.state_version != OLD.state_version + 1;
  SELECT RAISE(ABORT, 'race_video_validation terminal state is immutable')
  WHERE OLD.status != 'pending';
  SELECT RAISE(ABORT, 'race_video_validation source is not current')
  WHERE NOT EXISTS (
    SELECT 1 FROM race_video
    WHERE id = OLD.race_video_id AND status = 'validating'
  );
END;

CREATE TRIGGER tracking_run_input_ready_race_video
BEFORE INSERT ON tracking_run_input
BEGIN
  SELECT RAISE(ABORT, 'tracking_run_input source is not ready')
  WHERE NOT EXISTS (
    SELECT 1
    FROM race_video
    INNER JOIN race_video_validation
      ON race_video_validation.race_video_id = race_video.id
    WHERE race_video.id = NEW.race_video_id
      AND race_video.owner_id = NEW.owner_id
      AND race_video.object_key = NEW.source_object_key
      AND race_video.actual_size = NEW.source_byte_count
      AND race_video.status = 'validating'
      AND race_video_validation.status = 'ready'
      AND race_video_validation.byte_count = NEW.source_byte_count
      AND race_video_validation.checksum_sha256 = NEW.source_checksum
      AND race_video_validation.width = NEW.source_width
      AND race_video_validation.height = NEW.source_height
  );
END;
