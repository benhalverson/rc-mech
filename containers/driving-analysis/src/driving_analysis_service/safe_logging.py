import json
import logging
from collections.abc import Mapping

LOGGER = logging.getLogger("driving_analysis_service")
MAX_SAFE_TIMING_MS = 24 * 60 * 60 * 1000
LOGGER.setLevel(logging.INFO)
LOGGER.propagate = False
_handler = logging.StreamHandler()
_handler.setFormatter(logging.Formatter("%(message)s"))
LOGGER.addHandler(_handler)


def log_stage(
    *,
    correlation_id: str,
    stage: str,
    elapsed_ms: int,
    outcome: str,
    facts: Mapping[str, int | str] | None = None,
) -> None:
    event: dict[str, int | str] = {
        "event": "race_video_validation.stage",
        "correlationId": correlation_id,
        "stage": stage,
        "elapsedMs": max(0, min(elapsed_ms, MAX_SAFE_TIMING_MS)),
        "outcome": outcome,
    }
    if facts is not None:
        event.update(facts)
    LOGGER.info(json.dumps(event, separators=(",", ":"), sort_keys=True))
