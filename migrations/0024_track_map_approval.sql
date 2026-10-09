ALTER TABLE track_map_version
	ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1;

CREATE TRIGGER IF NOT EXISTS track_map_version_insert_as_next_draft
	BEFORE INSERT ON track_map_version
	WHEN NEW.status <> 'draft'
		OR NEW.state_version <> 1
		OR NEW.approved_by IS NOT NULL
		OR NEW.approved_at IS NOT NULL
		OR NEW.retired_at IS NOT NULL
		OR NEW.version <> COALESCE((SELECT MAX(version) + 1 FROM track_map_version WHERE layout_id = NEW.layout_id), 1)
		OR (NEW.source_version_id IS NOT NULL
			AND COALESCE((SELECT status = 'approved' AND layout_id = NEW.layout_id FROM track_map_version WHERE id = NEW.source_version_id), 0) <> 1)
	BEGIN
		SELECT RAISE(ABORT, 'Track-map versions must be the next draft for their layout');
	END;

CREATE TRIGGER IF NOT EXISTS track_map_version_observed_transition
	BEFORE UPDATE ON track_map_version
	WHEN NEW.state_version <> OLD.state_version + 1
		OR NEW.id IS NOT OLD.id
		OR NEW.layout_id IS NOT OLD.layout_id
		OR NEW.version IS NOT OLD.version
		OR NEW.source_version_id IS NOT OLD.source_version_id
		OR NEW.created_by IS NOT OLD.created_by
		OR NEW.created_at IS NOT OLD.created_at
		OR (OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'approved'))
		OR (OLD.status = 'approved' AND NEW.status <> 'retired')
		OR OLD.status = 'retired'
		OR (OLD.status = 'draft' AND NEW.status = 'draft'
			AND (NEW.approved_by IS NOT OLD.approved_by
				OR NEW.approved_at IS NOT OLD.approved_at
				OR NEW.retired_at IS NOT OLD.retired_at))
		OR (OLD.status = 'draft' AND NEW.status = 'approved'
			AND (NEW.approved_by IS NULL
				OR NEW.approved_at IS NULL
				OR NEW.retired_at IS NOT OLD.retired_at
				OR NOT EXISTS (SELECT 1 FROM track_corner WHERE map_version_id = OLD.id)))
		OR (OLD.status = 'approved' AND NEW.status = 'retired'
			AND (NEW.approved_by IS NOT OLD.approved_by
				OR NEW.approved_at IS NOT OLD.approved_at
				OR NEW.retired_at IS NULL))
	BEGIN
		SELECT RAISE(ABORT, 'Track-map version changed since it was observed');
	END;

CREATE TRIGGER IF NOT EXISTS track_map_version_immutable_delete
	BEFORE DELETE ON track_map_version
	WHEN OLD.status IN ('approved', 'retired')
	BEGIN
		SELECT RAISE(ABORT, 'Approved Track-map versions are immutable');
	END;
