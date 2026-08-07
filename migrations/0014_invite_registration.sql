CREATE TABLE IF NOT EXISTS invite_code (
 id TEXT PRIMARY KEY,
 code TEXT NOT NULL UNIQUE COLLATE NOCASE,
 creator_id TEXT NOT NULL REFERENCES owner(id),
 status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'redeemed', 'revoked')),
 reserved_email TEXT,
 reserved_until TEXT,
 redeemed_email TEXT,
 redeemed_user_id TEXT REFERENCES owner(id),
 reserved_at TEXT,
 redeemed_at TEXT,
 revoked_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invite_code_creator_status ON invite_code(creator_id, status);
CREATE TABLE IF NOT EXISTS auth_rate_limit (
 key TEXT PRIMARY KEY,
 window_started_at INTEGER NOT NULL,
 count INTEGER NOT NULL DEFAULT 0
);
