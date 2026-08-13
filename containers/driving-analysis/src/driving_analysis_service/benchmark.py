"""Deterministic, provider-neutral Subject-observation benchmark mechanics."""

from collections.abc import Iterable
from itertools import pairwise
from statistics import mean, median

from driving_analysis_service.contracts import (
    AcceptedSubjectObservations,
    BenchmarkReport,
    CorpusManifest,
    DirectedGate,
    GroundTruth,
    GroundTruthCase,
    NormalizedPoint,
    SubjectObservation,
    TrackingGap,
)

TRUSTED_IDENTITY_THRESHOLD = 0.5


def _side(gate: DirectedGate, point: NormalizedPoint) -> float:
    return (gate.exit.x - gate.entry.x) * (point.y - gate.entry.y) - (
        gate.exit.y - gate.entry.y
    ) * (point.x - gate.entry.x)


def _on_segment(gate: DirectedGate, point: NormalizedPoint) -> bool:
    return (
        min(gate.entry.x, gate.exit.x) - 1e-9
        <= point.x
        <= max(gate.entry.x, gate.exit.x) + 1e-9
        and min(gate.entry.y, gate.exit.y) - 1e-9
        <= point.y
        <= max(gate.entry.y, gate.exit.y) + 1e-9
    )


def _crossing(
    first: SubjectObservation, second: SubjectObservation, gate: DirectedGate
) -> float | None:
    first_side = _side(gate, first.center)
    second_side = _side(gate, second.center)
    if first_side == second_side or (first_side == 0 and second_side == 0):
        return None
    fraction = abs(first_side) / (abs(first_side) + abs(second_side))
    x = first.center.x + fraction * (second.center.x - first.center.x)
    y = first.center.y + fraction * (second.center.y - first.center.y)
    crossing = NormalizedPoint(x=x, y=y)
    if not _on_segment(gate, crossing):
        return None
    movement = second_side - first_side
    if (gate.direction == "positive" and movement <= 0) or (
        gate.direction == "negative" and movement >= 0
    ):
        return None
    return first.timestamp_ms + fraction * (second.timestamp_ms - first.timestamp_ms)


def _crossings(
    observations: tuple[SubjectObservation, ...], gate: DirectedGate
) -> list[float]:
    return [
        crossing
        for first, second in pairwise(observations)
        if (crossing := _crossing(first, second, gate)) is not None
    ]


def _overlaps_gap(start: float, end: float, gaps: Iterable[TrackingGap]) -> bool:
    return any(
        start < gap.end_timestamp_ms and end > gap.start_timestamp_ms for gap in gaps
    )


def _case_result(
    truth: GroundTruthCase, candidate: AcceptedSubjectObservations
) -> tuple[int, int, int, list[float], tuple[int, int, int]]:
    trusted = tuple(
        observation
        for observation in candidate.observations
        if observation.visibility == "visible"
        and observation.identity_confidence >= TRUSTED_IDENTITY_THRESHOLD
    )
    switches = sum(
        observation.identity != truth.subject_identity
        and not any(
            gap.start_timestamp_ms <= observation.timestamp_ms <= gap.end_timestamp_ms
            for gap in (*truth.ambiguous_spans, *candidate.gaps)
        )
        for observation in candidate.observations
    )
    eligible = 0
    timing_errors: list[float] = []
    next_observation_ms = float("-inf")
    for expected in truth.passes:
        gates = truth.gates[expected.corner_id]
        entries = _crossings(trusted, gates.entry)
        exits = _crossings(trusted, gates.exit)
        matched = next(
            (
                (entry, exit_)
                for entry in entries
                if entry >= next_observation_ms
                for exit_ in exits
                if exit_ > entry
            ),
            None,
        )
        if matched is None or _overlaps_gap(matched[0], matched[1], candidate.gaps):
            continue
        eligible += 1
        next_observation_ms = matched[1]
        timing_errors.append(
            (matched[1] - matched[0])
            - (expected.exit_timestamp_ms - expected.entry_timestamp_ms)
        )
    timely = sum(
        any(
            candidate_gap.start_timestamp_ms <= truth_gap.start_timestamp_ms
            and candidate_gap.end_timestamp_ms >= truth_gap.start_timestamp_ms
            for candidate_gap in candidate.gaps
        )
        for truth_gap in truth.ambiguous_spans
    )
    missed = len(truth.ambiguous_spans) - timely
    premature = sum(
        not any(
            candidate_gap.start_timestamp_ms < truth_gap.end_timestamp_ms
            and candidate_gap.end_timestamp_ms > truth_gap.start_timestamp_ms
            for truth_gap in truth.ambiguous_spans
        )
        for candidate_gap in candidate.gaps
    )
    return (
        len(truth.passes),
        eligible,
        switches,
        timing_errors,
        (timely, missed, premature),
    )


def evaluate_benchmark(
    manifest: CorpusManifest,
    ground_truth: GroundTruth,
    observations: dict[str, AcceptedSubjectObservations],
) -> BenchmarkReport:
    """Evaluate stored observations without invoking inference or external services."""
    if manifest.corpus_id != ground_truth.corpus_id:
        raise ValueError("manifest and ground truth corpus IDs differ")  # noqa: EM101, TRY003
    truth_by_case = {case.case_id: case for case in ground_truth.cases}
    if set(truth_by_case) != {case.case_id for case in manifest.cases} or set(
        observations
    ) != set(truth_by_case):
        raise ValueError(  # noqa: TRY003
            "manifest, ground truth, and observations must contain the same cases"  # noqa: EM101
        )
    totals = [0, 0, 0]
    errors: list[float] = []
    gap_counts = [0, 0, 0]
    for case in manifest.cases:
        candidate = observations[case.case_id]
        if any(
            observation.timestamp_ms < case.window_start_ms
            or observation.timestamp_ms > case.window_end_ms
            for observation in candidate.observations
        ):
            raise ValueError("observation is outside benchmark window")  # noqa: EM101, TRY003
        if any(
            gap.start_timestamp_ms < case.window_start_ms
            or gap.end_timestamp_ms > case.window_end_ms
            for gap in candidate.gaps
        ):
            raise ValueError("tracking gap is outside benchmark window")  # noqa: EM101, TRY003
        result = _case_result(truth_by_case[case.case_id], candidate)
        totals = [left + right for left, right in zip(totals, result[:3], strict=True)]
        errors.extend(result[3])
        gap_counts = [
            left + right for left, right in zip(gap_counts, result[4], strict=True)
        ]
    coverage = totals[1] / totals[0] if totals[0] else 0.0
    timing = {
        "count": len(errors),
        "meanMs": mean(errors) if errors else None,
        "medianMs": median(errors) if errors else None,
        "maxAbsoluteMs": max((abs(error) for error in errors), default=None),
    }
    return BenchmarkReport(
        contractVersion="subject-benchmark.v1",
        corpusId=manifest.corpus_id,
        provenance=manifest.provenance,
        passed=totals[2] == 0 and coverage >= manifest.required_coverage,
        coverage={
            "eligiblePasses": totals[1],
            "groundTruthPasses": totals[0],
            "ratio": coverage,
        },
        gaps={
            "timely": gap_counts[0],
            "missed": gap_counts[1],
            "premature": gap_counts[2],
        },
        identity={"unflaggedSwitches": totals[2]},
        timing=timing,
    )
