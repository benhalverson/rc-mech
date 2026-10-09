import random

from driving_analysis_service.benchmark_contracts import GroundTruthPass
from driving_analysis_service.pass_matching import CandidatePass, OrderedPassMatcher


def expected(entry: int, exit_ms: int) -> GroundTruthPass:
    return GroundTruthPass(
        passId="pass",
        cornerId="corner",
        entryTimestampMs=entry,
        exitTimestampMs=exit_ms,
    )


def test_index_agrees_with_exhaustive_matching_and_first_index_ties() -> None:
    randomizer = random.Random(274)  # noqa: S311 - deterministic test cases, not security
    for _ in range(100):
        entries = sorted(randomizer.randrange(0, 100) for _ in range(37))
        exits = sorted(randomizer.randrange(100, 200) for _ in range(37))
        candidates = tuple(
            CandidatePass(a, b) for a, b in zip(entries, exits, strict=True)
        )
        matcher = OrderedPassMatcher(candidates)
        next_index = 0
        for _ in range(10):
            truth = expected(
                randomizer.randrange(0, 150), randomizer.randrange(151, 250)
            )
            tolerance = randomizer.randrange(0, 200)
            eligible = (
                (i, item)
                for i, item in enumerate(candidates)
                if i >= next_index
                and abs(item.entry_ms - truth.entry_timestamp_ms) <= tolerance
                and abs(item.exit_ms - truth.exit_timestamp_ms) <= tolerance
            )
            best = min(
                eligible,
                key=lambda pair: (
                    abs(pair[1].entry_ms - truth.entry_timestamp_ms)
                    + abs(pair[1].exit_ms - truth.exit_timestamp_ms),
                    pair[0],
                ),
                default=None,
            )
            assert matcher.match(truth, tolerance) == (best[1] if best else None)
            if best:
                next_index = best[0] + 1
            assert matcher.next_index == next_index
    assert OrderedPassMatcher(()).match(expected(0, 1), 10) is None


def test_maximum_pass_count_with_broad_tolerance_is_one_to_one() -> None:
    candidates = tuple(CandidatePass(i, i + 1) for i in range(50_000))
    matcher = OrderedPassMatcher(candidates)
    for index in range(10_000):
        assert matcher.match(expected(index, index + 1), 10_000) == candidates[index]
    assert matcher.next_index == 10_000
