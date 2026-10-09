"""Linear cursors over validated, ordered, non-overlapping Tracking gaps.

Queries must have nondecreasing starts. Closed endpoints are deliberate: touching
an ambiguity boundary cannot supply a trusted observation or gate crossing.
"""

from driving_analysis_service.contracts import TrackingGap


class OrderedGapCursor:
    """Single-pass cursor used by benchmark crossing, identity, and gap metrics.

    Each metric owns a cursor over validated ordered, non-overlapping gaps and
    must query nondecreasing starts. Closed endpoints deliberately reject trusted
    evidence touching ambiguity; consuming a match prevents reusing the same gap.
    """

    def __init__(self, gaps: tuple[TrackingGap, ...]) -> None:
        self._gaps = gaps
        self._index = 0

    def advance_to(self, timestamp_ms: float) -> TrackingGap | None:
        while (
            self._index < len(self._gaps)
            and self._gaps[self._index].end_timestamp_ms < timestamp_ms
        ):
            self._index += 1
        return self._gaps[self._index] if self._index < len(self._gaps) else None

    def consume(self) -> None:
        self._index += 1

    def overlaps_closed(self, start_ms: float, end_ms: float) -> bool:
        gap = self.advance_to(start_ms)
        return gap is not None and gap.start_timestamp_ms <= end_ms

    def contains_closed(self, timestamp_ms: float) -> bool:
        return self.overlaps_closed(timestamp_ms, timestamp_ms)
