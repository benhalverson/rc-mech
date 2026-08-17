CREATE TABLE IF NOT EXISTS track_layout (
	 id TEXT PRIMARY KEY NOT NULL,
	 name TEXT NOT NULL,
	 status TEXT NOT NULL DEFAULT 'active',
	 created_by TEXT NOT NULL REFERENCES owner(id),
	 created_at TEXT NOT NULL,
	 updated_at TEXT NOT NULL,
	 retired_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS track_layout_name_idx
	ON track_layout(name);

CREATE TABLE IF NOT EXISTS track_map_version (
	 id TEXT PRIMARY KEY NOT NULL,
	 layout_id TEXT NOT NULL REFERENCES track_layout(id),
	 version INTEGER NOT NULL,
	 status TEXT NOT NULL DEFAULT 'draft',
	 source_version_id TEXT REFERENCES track_map_version(id),
	 created_by TEXT NOT NULL REFERENCES owner(id),
	 created_at TEXT NOT NULL,
	 updated_at TEXT NOT NULL,
	 approved_by TEXT REFERENCES owner(id),
	 approved_at TEXT,
	 retired_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS track_map_version_layout_version_idx
	ON track_map_version(layout_id, version);
CREATE INDEX IF NOT EXISTS track_map_version_layout_status_idx
	ON track_map_version(layout_id, status, version);

CREATE TABLE IF NOT EXISTS track_corner (
	 id TEXT PRIMARY KEY NOT NULL,
	 map_version_id TEXT NOT NULL REFERENCES track_map_version(id) ON DELETE CASCADE,
	 corner_key TEXT NOT NULL,
	 corner_name TEXT NOT NULL,
	 corner_order INTEGER NOT NULL,
	 entry_start_x REAL NOT NULL,
	 entry_start_y REAL NOT NULL,
	 entry_end_x REAL NOT NULL,
	 entry_end_y REAL NOT NULL,
	 entry_direction TEXT NOT NULL,
	 exit_start_x REAL NOT NULL,
	 exit_start_y REAL NOT NULL,
	 exit_end_x REAL NOT NULL,
	 exit_end_y REAL NOT NULL,
	 exit_direction TEXT NOT NULL,
	 view_x REAL NOT NULL,
	 view_y REAL NOT NULL,
	 view_width REAL NOT NULL,
	 view_height REAL NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS track_corner_version_key_idx
	ON track_corner(map_version_id, corner_key);
CREATE UNIQUE INDEX IF NOT EXISTS track_corner_version_order_idx
	ON track_corner(map_version_id, corner_order);
