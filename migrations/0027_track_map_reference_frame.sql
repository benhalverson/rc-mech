CREATE TABLE track_map_reference_frame (
	id TEXT PRIMARY KEY NOT NULL,
	map_version_id TEXT NOT NULL REFERENCES track_map_version(id) ON DELETE CASCADE,
	race_video_id TEXT NOT NULL,
	timestamp_ms INTEGER NOT NULL,
	object_key TEXT NOT NULL,
	byte_count INTEGER NOT NULL CHECK (byte_count > 0),
	checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
	content_type TEXT NOT NULL CHECK (content_type = 'image/jpeg'),
	created_by TEXT NOT NULL REFERENCES owner(id),
	created_at TEXT NOT NULL
);

CREATE INDEX track_map_reference_frame_version_idx
	ON track_map_reference_frame(map_version_id);

CREATE TRIGGER track_map_reference_frame_draft_only
	BEFORE INSERT ON track_map_reference_frame
	WHEN COALESCE((SELECT status FROM track_map_version WHERE id = NEW.map_version_id), '') <> 'draft'
	BEGIN
		SELECT RAISE(ABORT, 'Reference frames can only be attached to drafts');
	END;

CREATE TRIGGER track_map_reference_frame_immutable
	BEFORE UPDATE ON track_map_reference_frame
	BEGIN
		SELECT RAISE(ABORT, 'Track-map reference frames are immutable');
	END;

CREATE TRIGGER track_map_reference_frame_no_approved_delete
	BEFORE DELETE ON track_map_reference_frame
	WHEN COALESCE((SELECT status FROM track_map_version WHERE id = OLD.map_version_id), '') IN ('approved', 'retired')
	BEGIN
		SELECT RAISE(ABORT, 'Approved Track-map reference frames are immutable');
	END;

CREATE TRIGGER track_map_approval_requires_reference_frame
	BEFORE UPDATE ON track_map_version
	WHEN OLD.status = 'draft' AND NEW.status = 'approved'
		AND NOT EXISTS (SELECT 1 FROM track_map_reference_frame WHERE map_version_id = OLD.id)
	BEGIN
		SELECT RAISE(ABORT, 'Approved Track maps require a reference frame');
	END;
