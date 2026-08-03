CREATE TABLE maintenance_plan_new (
  id TEXT PRIMARY KEY,
  car_id TEXT NOT NULL REFERENCES car(id),
  component_id TEXT REFERENCES component(id),
  name TEXT NOT NULL,
  interval_days INTEGER,
  interval_sessions INTEGER,
  interval_unit TEXT NOT NULL DEFAULT 'days',
  interval_value INTEGER NOT NULL DEFAULT 1,
  baseline_at TEXT NOT NULL,
  baseline_session_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  pause_reason TEXT,
  paused_at TEXT
);
INSERT INTO maintenance_plan_new (id, car_id, component_id, name, interval_days, interval_sessions, interval_unit, interval_value, baseline_at, status, paused_at)
SELECT id, car_id, component_id, name, interval_days, interval_sessions,
  CASE WHEN interval_days IS NOT NULL THEN 'days' ELSE 'days' END,
  CASE WHEN interval_days IS NOT NULL THEN interval_days ELSE 1 END,
  baseline_at, status, paused_at
FROM maintenance_plan;
DROP TABLE maintenance_plan;
ALTER TABLE maintenance_plan_new RENAME TO maintenance_plan;
CREATE INDEX maintenance_plan_car_status_idx ON maintenance_plan(car_id, status);
CREATE INDEX maintenance_plan_component_idx ON maintenance_plan(component_id);

ALTER TABLE service_record ADD COLUMN plan_id TEXT REFERENCES maintenance_plan(id);
ALTER TABLE service_record ADD COLUMN baseline_session_count INTEGER;
ALTER TABLE service_record ADD COLUMN previous_baseline_at TEXT;
ALTER TABLE service_record ADD COLUMN previous_baseline_session_count INTEGER;
ALTER TABLE service_record ADD COLUMN deleted_at TEXT;
CREATE INDEX service_record_plan_idx ON service_record(plan_id, performed_at);
