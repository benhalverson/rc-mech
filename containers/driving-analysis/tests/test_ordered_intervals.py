from driving_analysis_service.observation_contracts import TrackingGap
from driving_analysis_service.ordered_intervals import OrderedGapCursor


def test_closed_boundaries_consumption_and_exhaustion() -> None:
    first = TrackingGap(startTimestampMs=10, endTimestampMs=20, reason="missing")
    second = TrackingGap(startTimestampMs=30, endTimestampMs=40, reason="occluded")
    cursor = OrderedGapCursor((first, second))
    assert not cursor.overlaps_closed(0, 9)
    assert cursor.overlaps_closed(0, 10)
    assert cursor.contains_closed(10)
    assert cursor.contains_closed(20)
    assert not cursor.contains_closed(21)
    assert cursor.advance_to(21) == second
    cursor.consume()
    assert not cursor.contains_closed(30)
    assert cursor.advance_to(40) is None
    assert not OrderedGapCursor(()).overlaps_closed(0, 100)
