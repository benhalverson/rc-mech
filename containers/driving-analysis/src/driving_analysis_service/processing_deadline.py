import time

from driving_analysis_service.processes import ProcessTimeoutError


def start_deadline(timeout_seconds: float) -> float:
    return time.monotonic() + timeout_seconds


def remaining_seconds(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProcessTimeoutError
    return remaining


def check_deadline(deadline: float | None) -> None:
    if deadline is not None:
        remaining_seconds(deadline)
