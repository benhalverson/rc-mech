"""Nonblocking admission shared by bounded media-processing stages."""

from collections.abc import Iterator
from contextlib import contextmanager
from threading import BoundedSemaphore


@contextmanager
def processing_slot(admission: BoundedSemaphore) -> Iterator[bool]:
    """Borrow a media-stage slot without waiting or creating another work queue.

    Preparation, rendering, tracking, and frame extraction use the yielded bool
    to return their own busy outcome. Release only an acquired slot, including
    when the caller raises, so stage-specific early exits cannot leak capacity.
    """

    acquired = admission.acquire(blocking=False)
    try:
        yield acquired
    finally:
        if acquired:
            admission.release()
