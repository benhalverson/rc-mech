-- Waiting analyses do not consume GPU capacity. The coordinator serializes
-- processing; creating another analysis must not require deleting prior work.
DROP TRIGGER IF EXISTS driving_analysis_owner_active_quota;
