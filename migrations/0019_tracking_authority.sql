CREATE TABLE inference_profile (
  profile_digest TEXT PRIMARY KEY CHECK (length(profile_digest) = 64),
  contract_version TEXT NOT NULL,
  canonicalization_version TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE tracking_run (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  run_sequence INTEGER NOT NULL CHECK (run_sequence > 0),
  workflow_id TEXT NOT NULL UNIQUE,
  profile_digest TEXT NOT NULL REFERENCES inference_profile(profile_digest),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active',
    'completed',
    'cancelled',
    'replaced',
    'failed'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (analysis_id, run_sequence)
);

CREATE INDEX tracking_run_owner_analysis
  ON tracking_run(owner_id, analysis_id);

CREATE TABLE prepared_tracking_media (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES tracking_run(id),
  descriptor_json TEXT NOT NULL,
  preparation_input_digest TEXT NOT NULL CHECK (length(preparation_input_digest) = 64),
  prepared_checksum TEXT NOT NULL CHECK (length(prepared_checksum) = 64),
  frame_manifest_checksum TEXT NOT NULL CHECK (length(frame_manifest_checksum) = 64),
  source_checksum TEXT NOT NULL CHECK (length(source_checksum) = 64),
  window_start_timestamp_ms INTEGER NOT NULL,
  window_end_timestamp_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (window_end_timestamp_ms > window_start_timestamp_ms)
);

CREATE TABLE tracking_segment (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES tracking_run(id),
  segment_order INTEGER NOT NULL CHECK (segment_order >= 0),
  seed_kind TEXT NOT NULL CHECK (seed_kind IN ('initial', 'reidentification')),
  seed_source_id TEXT,
  seed_json TEXT NOT NULL,
  prepared_media_id TEXT NOT NULL REFERENCES prepared_tracking_media(id),
  race_window_end_timestamp_ms INTEGER NOT NULL,
  profile_digest TEXT NOT NULL REFERENCES inference_profile(profile_digest),
  specification_version TEXT NOT NULL,
  specification_digest TEXT NOT NULL CHECK (length(specification_digest) = 64),
  availability_deadline_at INTEGER NOT NULL,
  current_attempt_id TEXT,
  authority_lease_id TEXT,
  authority_fence INTEGER,
  outcome TEXT CHECK (outcome IN ('completed', 'tracking-gap')),
  gap_json TEXT,
  accepted_artifact_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, segment_order),
  UNIQUE (run_id, specification_digest),
  CHECK (
    (seed_kind = 'initial' AND seed_source_id IS NULL) OR
    (seed_kind = 'reidentification' AND seed_source_id IS NOT NULL)
  ),
  CHECK (
    (current_attempt_id IS NULL AND authority_lease_id IS NULL AND authority_fence IS NULL) OR
    (current_attempt_id IS NOT NULL AND authority_lease_id IS NOT NULL AND authority_fence > 0)
  ),
  CHECK (
    (outcome IS NULL AND accepted_artifact_id IS NULL AND gap_json IS NULL) OR
    (outcome = 'completed' AND accepted_artifact_id IS NOT NULL AND gap_json IS NULL) OR
    (outcome = 'tracking-gap' AND accepted_artifact_id IS NOT NULL AND gap_json IS NOT NULL)
  )
);

CREATE INDEX tracking_segment_current_attempt
  ON tracking_segment(current_attempt_id);

CREATE TABLE tracking_execution_attempt (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES tracking_segment(id),
  profile_digest TEXT NOT NULL CHECK (length(profile_digest) = 64),
  specification_digest TEXT NOT NULL CHECK (length(specification_digest) = 64),
  lease_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  state TEXT NOT NULL CHECK (state IN (
    'proposed',
    'active',
    'transferring',
    'processing',
    'output-ready',
    'completed',
    'failed',
    'cancelled',
    'expired',
    'replaced'
  )),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 99),
  safe_failure_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (lease_id, fence)
);

CREATE INDEX tracking_attempt_segment
  ON tracking_execution_attempt(segment_id);

CREATE TABLE tracking_transfer_request (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES tracking_execution_attempt(id),
  role TEXT NOT NULL CHECK (role IN (
    'prepared-media',
    'frame-manifest',
    'observation-artifact'
  )),
  method TEXT NOT NULL CHECK (method IN ('GET', 'PUT')),
  object_scope TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'required' CHECK (state IN ('required', 'granted', 'completed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (attempt_id, role),
  CHECK (
    (role = 'observation-artifact' AND method = 'PUT') OR
    (role <> 'observation-artifact' AND method = 'GET')
  )
);

CREATE TABLE subject_observation_artifact (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES tracking_run(id),
  segment_id TEXT NOT NULL UNIQUE REFERENCES tracking_segment(id),
  attempt_id TEXT NOT NULL REFERENCES tracking_execution_attempt(id),
  profile_digest TEXT NOT NULL CHECK (length(profile_digest) = 64),
  specification_digest TEXT NOT NULL CHECK (length(specification_digest) = 64),
  lease_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  accepted_object_key TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  contract_digest TEXT NOT NULL CHECK (length(contract_digest) = 64),
  byte_count INTEGER NOT NULL CHECK (byte_count > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'tracking-gap')),
  gap_json TEXT,
  first_timestamp_ms INTEGER,
  last_timestamp_ms INTEGER,
  created_at TEXT NOT NULL,
  CHECK (
    (outcome = 'completed' AND gap_json IS NULL) OR
    (outcome = 'tracking-gap' AND gap_json IS NOT NULL)
  )
);

CREATE VIEW tracking_public_provenance AS
SELECT
  tracking_run.owner_id,
  tracking_run.analysis_id,
  tracking_run.id AS run_id,
  tracking_run.profile_digest,
  tracking_segment.id AS segment_id,
  tracking_segment.segment_order,
  tracking_segment.outcome,
  tracking_segment.gap_json,
  subject_observation_artifact.id AS artifact_id,
  subject_observation_artifact.checksum_sha256 AS artifact_digest,
  subject_observation_artifact.contract_digest,
  subject_observation_artifact.byte_count
FROM tracking_run
LEFT JOIN tracking_segment
  ON tracking_segment.run_id = tracking_run.id
LEFT JOIN subject_observation_artifact
  ON subject_observation_artifact.id = tracking_segment.accepted_artifact_id;

CREATE TRIGGER inference_profile_immutable_update
BEFORE UPDATE ON inference_profile
BEGIN
  SELECT RAISE(ABORT, 'inference_profile is immutable');
END;

CREATE TRIGGER inference_profile_immutable_delete
BEFORE DELETE ON inference_profile
BEGIN
  SELECT RAISE(ABORT, 'inference_profile is immutable');
END;

CREATE TRIGGER tracking_run_identity_immutable
BEFORE UPDATE OF analysis_id, owner_id, run_sequence, workflow_id, profile_digest, input_digest, created_at
ON tracking_run
BEGIN
  SELECT RAISE(ABORT, 'tracking_run identity is immutable');
END;

CREATE TRIGGER tracking_run_immutable_delete
BEFORE DELETE ON tracking_run
BEGIN
  SELECT RAISE(ABORT, 'tracking_run is immutable');
END;

CREATE TRIGGER prepared_tracking_media_immutable_update
BEFORE UPDATE ON prepared_tracking_media
BEGIN
  SELECT RAISE(ABORT, 'prepared_tracking_media is immutable');
END;

CREATE TRIGGER prepared_tracking_media_immutable_delete
BEFORE DELETE ON prepared_tracking_media
BEGIN
  SELECT RAISE(ABORT, 'prepared_tracking_media is immutable');
END;

CREATE TRIGGER tracking_segment_specification_immutable
BEFORE UPDATE OF run_id, segment_order, seed_kind, seed_source_id, seed_json,
  prepared_media_id, race_window_end_timestamp_ms, profile_digest,
  specification_version, specification_digest, availability_deadline_at, created_at
ON tracking_segment
BEGIN
  SELECT RAISE(ABORT, 'tracking_segment specification is immutable');
END;

CREATE TRIGGER tracking_segment_immutable_delete
BEFORE DELETE ON tracking_segment
BEGIN
  SELECT RAISE(ABORT, 'tracking_segment is immutable');
END;

CREATE TRIGGER tracking_attempt_identity_immutable
BEFORE UPDATE OF segment_id, profile_digest, specification_digest, lease_id, fence, created_at
ON tracking_execution_attempt
BEGIN
  SELECT RAISE(ABORT, 'tracking_execution_attempt identity is immutable');
END;

CREATE TRIGGER tracking_attempt_immutable_delete
BEFORE DELETE ON tracking_execution_attempt
BEGIN
  SELECT RAISE(ABORT, 'tracking_execution_attempt is immutable');
END;

CREATE TRIGGER tracking_transfer_scope_immutable
BEFORE UPDATE OF attempt_id, role, method, object_scope, created_at
ON tracking_transfer_request
BEGIN
  SELECT RAISE(ABORT, 'tracking_transfer_request scope is immutable');
END;

CREATE TRIGGER tracking_transfer_immutable_delete
BEFORE DELETE ON tracking_transfer_request
BEGIN
  SELECT RAISE(ABORT, 'tracking_transfer_request is immutable');
END;

CREATE TRIGGER subject_observation_artifact_immutable_update
BEFORE UPDATE ON subject_observation_artifact
BEGIN
  SELECT RAISE(ABORT, 'subject_observation_artifact is immutable');
END;

CREATE TRIGGER subject_observation_artifact_immutable_delete
BEFORE DELETE ON subject_observation_artifact
BEGIN
  SELECT RAISE(ABORT, 'subject_observation_artifact is immutable');
END;
