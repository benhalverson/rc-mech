ALTER TABLE tracking_segment ADD COLUMN wait_reason TEXT CHECK (wait_reason IN ('waiting-for-provider', 'waiting-for-capacity'));
ALTER TABLE tracking_run ADD COLUMN safe_failure_code TEXT CHECK (safe_failure_code IN ('TRACKING_PROVIDER_UNAVAILABLE', 'TRACKING_PROVIDER_FAILED', 'TRACKING_ARTIFACT_INVALID'));
