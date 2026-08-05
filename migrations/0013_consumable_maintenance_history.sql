CREATE TABLE consumable_maintenance_entry (
  id TEXT PRIMARY KEY,
  car_id TEXT NOT NULL REFERENCES car(id),
  kind TEXT NOT NULL CHECK (kind IN ('fluid', 'tires')),
  performed_at TEXT NOT NULL,
  fluid_area TEXT CHECK (fluid_area IS NULL OR fluid_area IN ('front-shocks', 'rear-shocks', 'front-differential', 'rear-differential', 'custom')),
  custom_fluid_area TEXT,
  front_details TEXT,
  front_cost REAL,
  front_currency TEXT,
  rear_details TEXT,
  rear_cost REAL,
  rear_currency TEXT,
  cost REAL,
  currency TEXT,
  notes TEXT,
  prefilled_from_setup_id TEXT REFERENCES setup(id),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'fluid' AND fluid_area IS NOT NULL AND front_details IS NULL AND rear_details IS NULL) OR
         (kind = 'tires' AND fluid_area IS NULL AND (front_details IS NOT NULL OR rear_details IS NOT NULL))),
  CHECK ((cost IS NULL) = (currency IS NULL)),
  CHECK ((front_cost IS NULL) = (front_currency IS NULL)),
  CHECK ((rear_cost IS NULL) = (rear_currency IS NULL))
);
CREATE INDEX consumable_entry_car_date_idx ON consumable_maintenance_entry(car_id, archived_at, performed_at DESC);
CREATE INDEX consumable_entry_setup_idx ON consumable_maintenance_entry(prefilled_from_setup_id);
