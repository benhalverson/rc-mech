UPDATE photo
SET is_primary = 1
WHERE id IN (
  SELECT current_photo.id
  FROM photo AS current_photo
  WHERE current_photo.id = (
    SELECT candidate.id
    FROM photo AS candidate
    WHERE candidate.car_id = current_photo.car_id
    ORDER BY candidate.created_at, candidate.id
    LIMIT 1
  )
);
