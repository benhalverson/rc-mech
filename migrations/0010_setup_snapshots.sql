CREATE TABLE setup (
  id TEXT PRIMARY KEY,
  car_id TEXT NOT NULL REFERENCES car(id),
  status TEXT NOT NULL DEFAULT 'active',
  setup_date TEXT,
  track TEXT,
  event TEXT,
  surface TEXT,
  traction TEXT,
  moisture TEXT,
  condition TEXT,
  temperature TEXT,
  vehicle TEXT,
  drivetrain TEXT,
  electronics TEXT,
  tires TEXT,
  shocks TEXT,
  front_suspension TEXT,
  rear_suspension TEXT,
  notes TEXT,
  source_url TEXT,
  source_pdf_reference TEXT,
  source_metadata TEXT,
  copied_from_id TEXT REFERENCES setup(id),
  raw_values TEXT,
  unmapped_values TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE car ADD COLUMN current_setup_id TEXT REFERENCES setup(id);

CREATE INDEX setup_car_updated_idx ON setup(car_id, updated_at);
CREATE INDEX setup_car_status_idx ON setup(car_id, status);
CREATE INDEX setup_copied_from_idx ON setup(copied_from_id);
