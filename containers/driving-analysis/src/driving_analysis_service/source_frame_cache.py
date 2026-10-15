"""Bounded reuse of source timestamps after the source bytes are verified."""

import time
from collections import OrderedDict
from dataclasses import dataclass

from driving_analysis_service.tracking_contracts import PreparedFrame

MAX_CACHED_FRAMES = 20_000
MAX_CACHED_SOURCES = 4
CACHE_TTL_SECONDS = 300


@dataclass(frozen=True)
class _Entry:
    expires_at: float
    frames: tuple[PreparedFrame, ...]


class SourceFrameCache:
    """Access is serialized by the source-frame service admission slot."""

    def __init__(self) -> None:
        self._entries: OrderedDict[tuple[str, int], _Entry] = OrderedDict()
        self._frame_count = 0

    def get(self, checksum: str, byte_count: int) -> tuple[PreparedFrame, ...]:
        self._expire()
        key = (checksum, byte_count)
        entry = self._entries.get(key)
        if entry is None:
            return ()
        self._entries.move_to_end(key)
        return entry.frames

    def remember(
        self, checksum: str, byte_count: int, frames: tuple[PreparedFrame, ...]
    ) -> None:
        if not frames or len(frames) > MAX_CACHED_FRAMES:
            return
        self._expire()
        key = (checksum, byte_count)
        old = self._entries.get(key)
        if old is not None:
            if old.frames[-1].frame_index >= frames[-1].frame_index:
                return
            del self._entries[key]
            self._frame_count -= len(old.frames)
        while self._entries and (
            len(self._entries) >= MAX_CACHED_SOURCES
            or self._frame_count + len(frames) > MAX_CACHED_FRAMES
        ):
            _, removed = self._entries.popitem(last=False)
            self._frame_count -= len(removed.frames)
        self._entries[key] = _Entry(time.monotonic() + CACHE_TTL_SECONDS, frames)
        self._frame_count += len(frames)

    def _expire(self) -> None:
        now = time.monotonic()
        for key, entry in tuple(self._entries.items()):
            if entry.expires_at <= now:
                del self._entries[key]
                self._frame_count -= len(entry.frames)
