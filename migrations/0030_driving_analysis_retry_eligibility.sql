DROP TRIGGER driving_analysis_workflow_retry;

CREATE TRIGGER driving_analysis_workflow_retry
BEFORE UPDATE OF workflow_id, workflow_sequence ON driving_analysis
BEGIN
  SELECT RAISE(ABORT, 'driving_analysis retry transition is invalid')
  WHERE NOT (
    NEW.workflow_id != OLD.workflow_id AND
    NEW.workflow_sequence = OLD.workflow_sequence + 1 AND
    (
      OLD.status IN ('failed', 'completed') OR
      (OLD.status = 'running' AND OLD.stage = 'preparation' AND
        OLD.progress = 15)
    ) AND
    NEW.status = 'queued' AND NEW.stage = 'preparation' AND
    NEW.progress = 0 AND NEW.state_version = OLD.state_version + 1
  );
END;
