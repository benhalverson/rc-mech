ALTER TABLE component ADD COLUMN slot_type TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE component ADD COLUMN manufacturer TEXT;
ALTER TABLE component ADD COLUMN model TEXT;

-- Classify existing rows without changing their slot identity. The API still
-- accepts arbitrary custom slot names, while common slots are advertised as
-- standard slots going forward.
UPDATE component
SET slot_type = 'standard'
WHERE lower(replace(slot, ' ', '-')) IN (
  'motor', 'esc', 'battery', 'steering-servo', 'throttle-servo',
  'receiver', 'gyro', 'transmitter', 'tires', 'wheels', 'shocks',
  'front-differential', 'center-differential', 'rear-differential',
  'slipper-clutch', 'pinion-gear', 'spur-gear', 'body', 'wing'
);

UPDATE component
SET slot = lower(replace(slot, ' ', '-'))
WHERE slot_type = 'standard';

-- The original endpoint did not enforce one current component per slot. Keep
-- the newest installation as current and close older duplicate current rows
-- before adding the partial unique index.
UPDATE component
SET removed_at = installed_at
WHERE removed_at IS NULL
  AND id NOT IN (
    SELECT id
    FROM (
      SELECT id,
        row_number() OVER (PARTITION BY car_id, slot ORDER BY installed_at DESC, id DESC) AS row_number
      FROM component
      WHERE removed_at IS NULL
    ) AS current_components
    WHERE row_number = 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS component_current_slot_unique_idx
  ON component(car_id, slot)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS component_car_installed_idx
  ON component(car_id, installed_at DESC);
