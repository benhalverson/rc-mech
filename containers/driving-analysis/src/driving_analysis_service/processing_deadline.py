import os
import time
from threading import BoundedSemaphore, Event, Thread

from driving_analysis_service.processes import ProcessTimeoutError

MAX_CONCURRENT_SYNCS = 1
_SYNC_SLOTS = BoundedSemaphore(MAX_CONCURRENT_SYNCS)


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


def fsync_with_deadline(descriptor: int, deadline: float | None) -> None:
    """Flush one descriptor without letting a stalled filesystem hold a request."""
    if deadline is None:
        os.fsync(descriptor)
        return

    check_deadline(deadline)
    slot = _SYNC_SLOTS
    if not slot.acquire(timeout=remaining_seconds(deadline)):
        raise ProcessTimeoutError

    duplicate = -1
    started = False
    try:
        duplicate = os.dup(descriptor)
        completed = Event()
        errors: list[OSError] = []

        def sync() -> None:
            try:
                os.fsync(duplicate)
            except OSError as error:
                errors.append(error)
            finally:
                try:
                    os.close(duplicate)
                finally:
                    slot.release()
                    completed.set()

        worker = Thread(target=sync, daemon=True, name="bounded-fsync")
        worker.start()
        started = True
    finally:
        if not started:
            if duplicate >= 0:
                os.close(duplicate)
            slot.release()

    if not completed.wait(remaining_seconds(deadline)):
        raise ProcessTimeoutError
    if errors:
        raise errors[0]
    check_deadline(deadline)
