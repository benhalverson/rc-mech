CREATE TABLE voice_update (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner(id),
  car_id TEXT NOT NULL REFERENCES car(id),
  drive_session_id TEXT REFERENCES drive_session(id),
  object_key TEXT UNIQUE,
  content_type TEXT,
  file_name TEXT,
  byte_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'needs-review', 'saved', 'failed', 'discarded')),
  transcript TEXT,
  draft_json TEXT,
  corrections_json TEXT,
  clarification_prompt TEXT,
  error TEXT,
  confirmed_at TEXT,
  artifact_deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((object_key IS NULL AND content_type IS NULL AND file_name IS NULL AND byte_size = 0) OR
         (object_key IS NOT NULL AND content_type IS NOT NULL AND file_name IS NOT NULL AND byte_size > 0))
);
CREATE INDEX voice_update_owner_created_idx ON voice_update(owner_id, created_at DESC);
CREATE INDEX voice_update_car_created_idx ON voice_update(car_id, created_at DESC);
CREATE INDEX voice_update_status_idx ON voice_update(owner_id, status, updated_at DESC);

CREATE TABLE voice_problem_note (
  id TEXT PRIMARY KEY,
  voice_update_id TEXT NOT NULL REFERENCES voice_update(id),
  car_id TEXT NOT NULL REFERENCES car(id),
  drive_session_id TEXT REFERENCES drive_session(id),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX voice_problem_note_car_created_idx ON voice_problem_note(car_id, created_at DESC);

CREATE TABLE voice_update_result (
  id TEXT PRIMARY KEY,
  voice_update_id TEXT NOT NULL REFERENCES voice_update(id),
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'drive-session', 'problem-note', 'consumable')),
  record_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX voice_update_result_voice_idx ON voice_update_result(voice_update_id, created_at);
