"""Nonblocking admission shared by bounded media-processing stages."""

from collections.abc import Iterator
from contextlib import contextmanager
from threading import BoundedSemaphore


@contextmanager
def processing_slot(admission: BoundedSemaphore) -> Iterator[bool]:
    acquired = admission.acquire(blocking=False)
    try:
        yield acquired
    finally:
        if acquired:
            admission.release()
