CREATE TABLE tracking_artifact_promotion (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES tracking_run(id),
  segment_id TEXT NOT NULL REFERENCES tracking_segment(id),
  attempt_id TEXT NOT NULL REFERENCES tracking_execution_attempt(id),
  transfer_request_id TEXT NOT NULL UNIQUE REFERENCES tracking_transfer_request(id),
  staging_object_key TEXT NOT NULL UNIQUE,
  accepted_object_key TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  contract_digest TEXT NOT NULL CHECK (length(contract_digest) = 64),
  byte_count INTEGER NOT NULL CHECK (byte_count > 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending',
    'promoted',
    'accepted',
    'deleting',
    'deleted'
  )),
  delete_after TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (
    (state = 'deleted' AND deleted_at IS NOT NULL) OR
    (state <> 'deleted' AND deleted_at IS NULL)
  )
);

CREATE INDEX tracking_artifact_promotion_cleanup
  ON tracking_artifact_promotion(state, delete_after);

CREATE TRIGGER tracking_artifact_promotion_identity_immutable
BEFORE UPDATE OF artifact_id, run_id, segment_id, attempt_id,
  transfer_request_id, staging_object_key, accepted_object_key,
  checksum_sha256, contract_digest, byte_count, delete_after, created_at
ON tracking_artifact_promotion
BEGIN
  SELECT RAISE(ABORT, 'tracking_artifact_promotion identity is immutable');
END;

CREATE TRIGGER tracking_artifact_promotion_immutable_delete
BEFORE DELETE ON tracking_artifact_promotion
BEGIN
  SELECT RAISE(ABORT, 'tracking_artifact_promotion is immutable');
END;
