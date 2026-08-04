ALTER TABLE photo ADD COLUMN file_name TEXT NOT NULL DEFAULT 'photo';
ALTER TABLE photo ADD COLUMN byte_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE photo ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE photo ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0;

CREATE INDEX photo_car_order_idx
  ON photo(car_id, sort_order, created_at);
