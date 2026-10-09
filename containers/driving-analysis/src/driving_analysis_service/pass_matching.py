"""Deterministic monotonic pass matching in O(C + P log C) time and O(C) space.

Ordered candidates have increasing entry and exit timestamps. Bisect intersects
both tolerance windows and the unconsumed suffix. Four static range-minimum
trees select the smallest L1 timing error in its four linear regions, even when
a broad tolerance window contains every candidate. Ties use the original index.
"""

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from math import inf

from driving_analysis_service.contracts import GroundTruthPass


@dataclass(frozen=True)
class CandidatePass:
    entry_ms: float
    exit_ms: float


class _RangeMinimum:
    def __init__(self, values: tuple[float, ...]) -> None:
        self.size = len(values)
        self.tree = [(inf, -1)] * self.size + list(
            zip(values, range(self.size), strict=True)
        )
        for index in range(self.size - 1, 0, -1):
            self.tree[index] = min(self.tree[index * 2], self.tree[index * 2 + 1])

    def best(self, start: int, end: int) -> tuple[float, int]:
        start += self.size
        end += self.size
        result = (inf, -1)
        while start < end:
            if start % 2:
                result = min(result, self.tree[start])
                start += 1
            if end % 2:
                end -= 1
                result = min(result, self.tree[end])
            start //= 2
            end //= 2
        return result


class OrderedPassMatcher:
    def __init__(self, candidates: tuple[CandidatePass, ...]) -> None:
        self.candidates = candidates
        self.entries = tuple(item.entry_ms for item in candidates)
        self.exits = tuple(item.exit_ms for item in candidates)
        self.next_index = 0
        self._regions = {
            (entry_sign, exit_sign): _RangeMinimum(
                tuple(
                    entry_sign * item.entry_ms + exit_sign * item.exit_ms
                    for item in candidates
                )
            )
            for entry_sign in (-1, 1)
            for exit_sign in (-1, 1)
        }

    def match(
        self, expected: GroundTruthPass, tolerance_ms: int
    ) -> CandidatePass | None:
        entry = expected.entry_timestamp_ms
        exit_ms = expected.exit_timestamp_ms
        start = max(
            self.next_index,
            bisect_left(self.entries, entry - tolerance_ms),
            bisect_left(self.exits, exit_ms - tolerance_ms),
        )
        end = min(
            bisect_right(self.entries, entry + tolerance_ms),
            bisect_right(self.exits, exit_ms + tolerance_ms),
        )
        entry_split = bisect_right(self.entries, entry)
        exit_split = bisect_right(self.exits, exit_ms)
        best = (inf, -1)
        for (entry_sign, exit_sign), region in self._regions.items():
            lower = max(
                start,
                entry_split if entry_sign == 1 else start,
                exit_split if exit_sign == 1 else start,
            )
            upper = min(
                end,
                entry_split if entry_sign == -1 else end,
                exit_split if exit_sign == -1 else end,
            )
            if lower < upper:
                error, index = region.best(lower, upper)
                best = min(
                    best, (error - entry_sign * entry - exit_sign * exit_ms, index)
                )
        if best[1] == -1:
            return None
        self.next_index = best[1] + 1
        return self.candidates[best[1]]
