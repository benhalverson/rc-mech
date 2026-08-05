CREATE TABLE setup_import_draft (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner(id),
  car_id TEXT REFERENCES car(id),
  source_url TEXT NOT NULL,
  source_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  source_identity TEXT,
  source_pdf_reference TEXT,
  source_metadata TEXT,
  known_values TEXT,
  uncertain_values TEXT,
  raw_values TEXT,
  unmapped_values TEXT,
  error TEXT,
  accepted_setup_id TEXT REFERENCES setup(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX setup_import_draft_owner_updated_idx
  ON setup_import_draft(owner_id, updated_at DESC);
CREATE INDEX setup_import_draft_owner_source_idx
  ON setup_import_draft(owner_id, source_key);
CREATE INDEX setup_import_draft_car_idx
  ON setup_import_draft(car_id, updated_at DESC);

CREATE UNIQUE INDEX setup_import_draft_open_source_uidx
  ON setup_import_draft(owner_id, source_key)
  WHERE status = 'draft';
