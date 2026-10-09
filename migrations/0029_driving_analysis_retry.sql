ALTER TABLE driving_analysis ADD COLUMN workflow_sequence INTEGER NOT NULL DEFAULT 1 CHECK (workflow_sequence > 0);

DROP TRIGGER driving_analysis_initial_state;
DROP TRIGGER driving_analysis_input_immutable;
DROP TRIGGER driving_analysis_lifecycle_transition;

CREATE TRIGGER driving_analysis_initial_state
BEFORE INSERT ON driving_analysis
BEGIN
  SELECT RAISE(ABORT, 'driving_analysis must start queued for preparation')
  WHERE NEW.status != 'queued' OR NEW.stage != 'preparation' OR
    NEW.progress != 0 OR NEW.state_version != 1 OR
    NEW.workflow_id != NEW.id OR NEW.workflow_sequence != 1 OR
    NEW.updated_at != NEW.created_at;
END;

CREATE TRIGGER driving_analysis_input_immutable
BEFORE UPDATE OF id, owner_id, request_id, request_digest, car_id,
  drive_session_id, race_video_id, race_window_start_ms, race_window_end_ms,
  approved_track_map_version_id, subject_seed_timestamp_ms,
  subject_seed_frame_index, subject_seed_identity, subject_box_x,
  subject_box_y, subject_box_width, subject_box_height, source_layout_version,
  source_layout_digest, source_width, source_height, created_at
ON driving_analysis
BEGIN
  SELECT RAISE(ABORT, 'driving_analysis input is immutable');
END;

CREATE TRIGGER driving_analysis_workflow_retry
BEFORE UPDATE OF workflow_id, workflow_sequence ON driving_analysis
BEGIN
  SELECT RAISE(ABORT, 'driving_analysis retry transition is invalid')
  WHERE NOT (
    NEW.workflow_id != OLD.workflow_id AND
    NEW.workflow_sequence = OLD.workflow_sequence + 1 AND
    OLD.status IN ('running', 'awaiting-reidentification', 'failed') AND
    NEW.status = 'queued' AND NEW.stage = 'preparation' AND
    NEW.progress = 0 AND NEW.state_version = OLD.state_version + 1
  );
END;

CREATE TRIGGER driving_analysis_lifecycle_transition
BEFORE UPDATE ON driving_analysis
BEGIN
  SELECT RAISE(ABORT, 'driving_analysis revision conflict')
  WHERE NEW.state_version != OLD.state_version + 1;
  SELECT RAISE(ABORT, 'driving_analysis progress cannot decrease')
  WHERE NEW.workflow_id = OLD.workflow_id AND NEW.progress < OLD.progress;
  SELECT RAISE(ABORT, 'driving_analysis stage cannot regress')
  WHERE NEW.workflow_id = OLD.workflow_id AND (
    (OLD.stage = 'tracking' AND NEW.stage = 'preparation') OR
    (OLD.stage = 'measurement' AND NEW.stage IN ('preparation', 'tracking')) OR
    (OLD.stage = 'clip-rendering' AND
      NEW.stage IN ('preparation', 'tracking', 'measurement')) OR
    (OLD.stage = 'finalization' AND NEW.stage != 'finalization')
  );
  SELECT RAISE(ABORT, 'driving_analysis terminal state is immutable')
  WHERE OLD.status = 'deleted';
  SELECT RAISE(ABORT, 'driving_analysis lifecycle transition is invalid')
  WHERE NEW.workflow_id = OLD.workflow_id AND (
    (OLD.status = 'queued' AND
      NEW.status NOT IN ('running', 'failed', 'cancelled', 'deleting')) OR
    (OLD.status = 'running' AND
      NEW.status NOT IN ('running', 'awaiting-reidentification', 'completed',
        'failed', 'cancelled', 'deleting')) OR
    (OLD.status = 'awaiting-reidentification' AND
      NEW.status NOT IN ('running', 'cancelled', 'deleting')) OR
    (OLD.status IN ('completed', 'failed', 'cancelled') AND
      NEW.status != 'deleting') OR
    (OLD.status = 'deleting' AND NEW.status NOT IN ('deleting', 'deleted'))
  );
END;
