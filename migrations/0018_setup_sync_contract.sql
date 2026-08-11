ALTER TABLE setup ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE setup ADD COLUMN last_operation_id TEXT;
ALTER TABLE car ADD COLUMN current_setup_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE car ADD COLUMN current_setup_operation_id TEXT;

CREATE TABLE sync_operation_new (
  owner_id TEXT NOT NULL REFERENCES owner(id),
  operation_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'car.create',
    'car.edit',
    'car.archive',
    'car.restore',
    'setup.create',
    'setup.correct',
    'setup.select-current'
  )),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('car', 'setup')),
  entity_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'applied', 'rejected', 'conflict')),
  http_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (owner_id, operation_id),
  CHECK (
    (outcome = 'pending' AND http_status IS NULL AND response_json IS NULL AND completed_at IS NULL) OR
    (outcome <> 'pending' AND http_status IS NOT NULL AND response_json IS NOT NULL AND completed_at IS NOT NULL)
  )
);

INSERT INTO sync_operation_new (
  owner_id,
  operation_id,
  contract_version,
  kind,
  entity_type,
  entity_id,
  request_hash,
  outcome,
  http_status,
  response_json,
  created_at,
  completed_at
)
SELECT
  owner_id,
  operation_id,
  contract_version,
  kind,
  entity_type,
  entity_id,
  request_hash,
  outcome,
  http_status,
  response_json,
  created_at,
  completed_at
FROM sync_operation;

DROP TABLE sync_operation;
ALTER TABLE sync_operation_new RENAME TO sync_operation;

CREATE INDEX sync_operation_owner_entity_idx
  ON sync_operation(owner_id, entity_type, entity_id, created_at);
