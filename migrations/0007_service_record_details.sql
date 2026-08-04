ALTER TABLE service_record ADD COLUMN notes TEXT;
ALTER TABLE service_record ADD COLUMN cost REAL;
ALTER TABLE service_record ADD COLUMN currency TEXT;

CREATE INDEX service_record_car_performed_idx
  ON service_record(car_id, deleted_at, performed_at);
