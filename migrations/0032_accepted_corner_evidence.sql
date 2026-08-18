CREATE TABLE corner_evidence_batch (
  artifact_id TEXT PRIMARY KEY REFERENCES subject_observation_artifact(id),
  owner_id TEXT NOT NULL,
  analysis_id TEXT NOT NULL REFERENCES driving_analysis(id),
  run_id TEXT NOT NULL REFERENCES tracking_run(id),
  workflow_id TEXT NOT NULL,
  segment_id TEXT NOT NULL REFERENCES tracking_segment(id),
  attempt_id TEXT NOT NULL REFERENCES tracking_execution_attempt(id),
  profile_digest TEXT NOT NULL CHECK (length(profile_digest) = 64),
  specification_digest TEXT NOT NULL CHECK (length(specification_digest) = 64),
  prepared_media_id TEXT NOT NULL REFERENCES prepared_tracking_media(id),
  observation_object_key TEXT NOT NULL,
  observation_checksum_sha256 TEXT NOT NULL CHECK (length(observation_checksum_sha256) = 64),
  observation_contract_digest TEXT NOT NULL CHECK (length(observation_contract_digest) = 64),
  manifest_object_key TEXT NOT NULL,
  manifest_checksum_sha256 TEXT NOT NULL CHECK (length(manifest_checksum_sha256) = 64),
  approved_track_map_version_id TEXT NOT NULL REFERENCES track_map_version(id),
  measurement_version TEXT NOT NULL,
  measurement_input_digest TEXT NOT NULL CHECK (length(measurement_input_digest) = 64),
  measurement_digest TEXT NOT NULL CHECK (length(measurement_digest) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (artifact_id, measurement_digest)
);

CREATE TABLE corner_pass_evidence (
  batch_artifact_id TEXT NOT NULL REFERENCES corner_evidence_batch(artifact_id),
  batch_measurement_digest TEXT NOT NULL CHECK (length(batch_measurement_digest) = 64),
  corner_id TEXT NOT NULL REFERENCES track_corner(id),
  corner_key TEXT NOT NULL,
  corner_order INTEGER NOT NULL CHECK (corner_order >= 0),
  pass_ordinal INTEGER NOT NULL CHECK (pass_ordinal > 0),
  entry_timestamp_ms REAL,
  entry_before_frame_index INTEGER,
  entry_after_frame_index INTEGER,
  exit_timestamp_ms REAL,
  exit_before_frame_index INTEGER,
  exit_after_frame_index INTEGER,
  duration_ms REAL,
  eligibility TEXT NOT NULL CHECK (eligibility IN ('eligible', 'ineligible')),
  exclusion_reason TEXT CHECK (exclusion_reason IN (
    'tracking-gap',
    'untrusted-crossing',
    'gate-order',
    'race-window'
  )),
  pass_rank INTEGER,
  tie_group INTEGER,
  best INTEGER NOT NULL CHECK (best IN (0, 1)),
  PRIMARY KEY (batch_artifact_id, corner_id, pass_ordinal),
  FOREIGN KEY (batch_artifact_id, batch_measurement_digest)
    REFERENCES corner_evidence_batch(artifact_id, measurement_digest),
  CHECK (
    (entry_timestamp_ms IS NULL AND entry_before_frame_index IS NULL AND entry_after_frame_index IS NULL) OR
    (entry_timestamp_ms IS NOT NULL AND entry_before_frame_index IS NOT NULL AND entry_after_frame_index IS NOT NULL)
  ),
  CHECK (
    (exit_timestamp_ms IS NULL AND exit_before_frame_index IS NULL AND exit_after_frame_index IS NULL) OR
    (exit_timestamp_ms IS NOT NULL AND exit_before_frame_index IS NOT NULL AND exit_after_frame_index IS NOT NULL)
  ),
  CHECK (
    (eligibility = 'eligible' AND entry_timestamp_ms IS NOT NULL AND exit_timestamp_ms IS NOT NULL
      AND duration_ms >= 0 AND exclusion_reason IS NULL AND pass_rank > 0 AND tie_group > 0) OR
    (eligibility = 'ineligible' AND exclusion_reason IS NOT NULL AND duration_ms IS NULL
      AND pass_rank IS NULL AND tie_group IS NULL AND best = 0)
  )
);

CREATE TRIGGER corner_evidence_batch_immutable_update
BEFORE UPDATE ON corner_evidence_batch
BEGIN
  SELECT RAISE(ABORT, 'corner_evidence_batch is immutable');
END;

CREATE TRIGGER corner_evidence_batch_immutable_delete
BEFORE DELETE ON corner_evidence_batch
BEGIN
  SELECT RAISE(ABORT, 'corner_evidence_batch is immutable');
END;

CREATE TRIGGER corner_pass_evidence_immutable_update
BEFORE UPDATE ON corner_pass_evidence
BEGIN
  SELECT RAISE(ABORT, 'corner_pass_evidence is immutable');
END;

CREATE TRIGGER corner_pass_evidence_immutable_delete
BEFORE DELETE ON corner_pass_evidence
BEGIN
  SELECT RAISE(ABORT, 'corner_pass_evidence is immutable');
END;
