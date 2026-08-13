"""Deterministic, provider-neutral Subject-observation benchmark mechanics."""

from collections.abc import Iterable
from dataclasses import dataclass
from itertools import pairwise
from statistics import mean, median

from driving_analysis_service.contracts import (
    AcceptedSubjectObservations,
    BenchmarkCase,
    BenchmarkProvenance,
    BenchmarkReport,
    CornerGates,
    CorpusManifest,
    CoverageMetrics,
    DirectedGate,
    GapMetrics,
    GateTimingMetrics,
    GroundTruth,
    GroundTruthCase,
    GroundTruthPass,
    IdentityMetrics,
    NormalizedBox,
    NormalizedPoint,
    SubjectObservation,
    SubjectProvenance,
    TrackingGap,
)


@dataclass(frozen=True)
class CandidatePass:
    entry_ms: float
    exit_ms: float


@dataclass(frozen=True)
class CaseResult:
    ground_truth_passes: int
    eligible_passes: int
    unflagged_switches: int
    timing_errors: tuple[float, ...]
    timely_gaps: int
    missed_gaps: int
    premature_gaps: int


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
    if first_side == second_side:
        return None
    fraction = abs(first_side) / (abs(first_side) + abs(second_side))
    crossing = NormalizedPoint(
        x=first.center.x + fraction * (second.center.x - first.center.x),
        y=first.center.y + fraction * (second.center.y - first.center.y),
    )
    if not _on_segment(gate, crossing):
        return None
    movement = second_side - first_side
    if (gate.direction == "positive" and movement <= 0) or (
        gate.direction == "negative" and movement >= 0
    ):
        return None
    return first.timestamp_ms + fraction * (second.timestamp_ms - first.timestamp_ms)


def _overlaps_gap(start: float, end: float, gaps: Iterable[TrackingGap]) -> bool:
    return any(
        start <= gap.end_timestamp_ms and end >= gap.start_timestamp_ms for gap in gaps
    )


def _covers(timestamp_ms: int, gaps: Iterable[TrackingGap]) -> bool:
    return any(
        gap.start_timestamp_ms <= timestamp_ms <= gap.end_timestamp_ms for gap in gaps
    )


def _is_trusted(observation: SubjectObservation, threshold: float) -> bool:
    return (
        observation.visibility == "visible"
        and observation.identity_confidence >= threshold
    )


def _crossings(
    candidate: AcceptedSubjectObservations,
    gate: DirectedGate,
    threshold: float,
) -> tuple[float, ...]:
    crossings: list[float] = []
    for first, second in pairwise(candidate.observations):
        if (
            not _is_trusted(first, threshold)
            or not _is_trusted(second, threshold)
            or _overlaps_gap(first.timestamp_ms, second.timestamp_ms, candidate.gaps)
        ):
            continue
        crossing = _crossing(first, second, gate)
        if crossing is not None:
            crossings.append(crossing)
    return tuple(crossings)


def _candidate_passes(
    candidate: AcceptedSubjectObservations,
    gates: CornerGates,
    threshold: float,
) -> tuple[CandidatePass, ...]:
    entries = _crossings(candidate, gates.entry, threshold)
    exits = _crossings(candidate, gates.exit, threshold)
    passes: list[CandidatePass] = []
    next_exit = 0
    for entry in entries:
        while next_exit < len(exits) and exits[next_exit] <= entry:
            next_exit += 1
        if next_exit == len(exits):
            break
        passes.append(CandidatePass(entry_ms=entry, exit_ms=exits[next_exit]))
        next_exit += 1
    return tuple(passes)


def _intersection_over_union(left: NormalizedBox, right: NormalizedBox) -> float:
    intersection_width = max(
        0.0, min(left.x + left.width, right.x + right.width) - max(left.x, right.x)
    )
    intersection_height = max(
        0.0,
        min(left.y + left.height, right.y + right.height) - max(left.y, right.y),
    )
    intersection = intersection_width * intersection_height
    union = left.width * left.height + right.width * right.height - intersection
    return intersection / union


def _unflagged_switches(
    truth: GroundTruthCase,
    candidate: AcceptedSubjectObservations,
    provenance: BenchmarkProvenance,
) -> int:
    by_frame = {item.frame_index: item for item in candidate.observations}
    switches = 0
    switch_active = False
    for annotation in truth.identity_annotations:
        observation = by_frame.get(annotation.frame_index)
        excluded = _covers(annotation.timestamp_ms, truth.ambiguous_spans) or _covers(
            annotation.timestamp_ms, candidate.gaps
        )
        mismatch = observation is not None and (
            not _is_trusted(observation, provenance.identity_confidence_threshold)
            or _intersection_over_union(observation.box, annotation.box)
            < provenance.identity_match_iou_threshold
        )
        if excluded or observation is None or not mismatch:
            switch_active = False
        elif not switch_active:
            switches += 1
            switch_active = True
    return switches


def _matching_pass(
    expected: GroundTruthPass,
    candidates: tuple[CandidatePass, ...],
    used: set[int],
    tolerance_ms: int,
) -> tuple[int, CandidatePass] | None:
    possible = (
        (index, candidate)
        for index, candidate in enumerate(candidates)
        if index not in used
        and abs(candidate.entry_ms - expected.entry_timestamp_ms) <= tolerance_ms
        and abs(candidate.exit_ms - expected.exit_timestamp_ms) <= tolerance_ms
    )
    return min(
        possible,
        key=lambda item: (
            abs(item[1].entry_ms - expected.entry_timestamp_ms)
            + abs(item[1].exit_ms - expected.exit_timestamp_ms),
            item[0],
        ),
        default=None,
    )


def _gap_counts(
    truth_gaps: tuple[TrackingGap, ...], candidate_gaps: tuple[TrackingGap, ...]
) -> tuple[int, int, int]:
    timely = sum(
        any(
            candidate.start_timestamp_ms
            <= truth.start_timestamp_ms
            <= candidate.end_timestamp_ms
            for candidate in candidate_gaps
        )
        for truth in truth_gaps
    )
    missed = len(truth_gaps) - timely
    premature = sum(
        not _overlaps_gap(
            candidate.start_timestamp_ms, candidate.end_timestamp_ms, truth_gaps
        )
        for candidate in candidate_gaps
    )
    return timely, missed, premature


def _case_result(
    truth: GroundTruthCase,
    candidate: AcceptedSubjectObservations,
    provenance: BenchmarkProvenance,
    tolerance_ms: int,
) -> CaseResult:
    passes_by_corner = {
        corner_id: _candidate_passes(
            candidate, gates, provenance.identity_confidence_threshold
        )
        for corner_id, gates in truth.gates.items()
    }
    used_by_corner: dict[str, set[int]] = {
        corner_id: set() for corner_id in truth.gates
    }
    timing_errors: list[float] = []
    eligible = 0
    for expected in truth.passes:
        matched = _matching_pass(
            expected,
            passes_by_corner[expected.corner_id],
            used_by_corner[expected.corner_id],
            tolerance_ms,
        )
        if matched is None:
            continue
        index, candidate_pass = matched
        used_by_corner[expected.corner_id].add(index)
        eligible += 1
        timing_errors.append(
            (candidate_pass.exit_ms - candidate_pass.entry_ms)
            - (expected.exit_timestamp_ms - expected.entry_timestamp_ms)
        )
    timely, missed, premature = _gap_counts(truth.ambiguous_spans, candidate.gaps)
    return CaseResult(
        ground_truth_passes=len(truth.passes),
        eligible_passes=eligible,
        unflagged_switches=_unflagged_switches(truth, candidate, provenance),
        timing_errors=tuple(timing_errors),
        timely_gaps=timely,
        missed_gaps=missed,
        premature_gaps=premature,
    )


def _provenance_matches(
    benchmark: BenchmarkProvenance, observation: SubjectProvenance
) -> bool:
    return (
        observation.provider == benchmark.provider
        and observation.model == benchmark.model
        and observation.model_version == benchmark.model_version
        and observation.model_digest == benchmark.model_digest
        and observation.pipeline_version == benchmark.pipeline_version
        and observation.configuration_digest == benchmark.configuration_digest
        and observation.identity_confidence_threshold
        == benchmark.identity_confidence_threshold
        and observation.confidence_calibration == benchmark.confidence_calibration
    )


def _validate_case_inputs(
    case: BenchmarkCase,
    truth: GroundTruthCase,
    candidate: AcceptedSubjectObservations,
    provenance: BenchmarkProvenance,
) -> None:
    if (
        candidate.case_id != case.case_id
        or case.subject_seed.identity != truth.subject_identity
    ):
        raise ValueError("case identity metadata differs")  # noqa: EM101, TRY003
    observation_outside = any(
        item.timestamp_ms < case.window_start_ms
        or item.timestamp_ms > case.window_end_ms
        for item in candidate.observations
    )
    annotation_outside = any(
        item.timestamp_ms < case.window_start_ms
        or item.timestamp_ms > case.window_end_ms
        for item in truth.identity_annotations
    )
    gap_outside = any(
        gap.start_timestamp_ms < case.window_start_ms
        or gap.end_timestamp_ms > case.window_end_ms
        for gap in (*candidate.gaps, *truth.ambiguous_spans)
    )
    if observation_outside or annotation_outside or gap_outside:
        raise ValueError("observation or gap is outside benchmark window")  # noqa: EM101, TRY003
    if any(
        item.entry_timestamp_ms < case.window_start_ms
        or item.exit_timestamp_ms > case.window_end_ms
        for item in truth.passes
    ):
        raise ValueError("ground-truth pass is outside benchmark window")  # noqa: EM101, TRY003
    if any(
        not _provenance_matches(provenance, item.provenance)
        for item in candidate.observations
    ):
        raise ValueError("observation provenance differs from benchmark")  # noqa: EM101, TRY003


def evaluate_benchmark(
    manifest: CorpusManifest,
    ground_truth: GroundTruth,
    observations: dict[str, AcceptedSubjectObservations],
) -> BenchmarkReport:
    """Evaluate stored observations without invoking inference or external services."""
    if manifest.corpus_id != ground_truth.corpus_id:
        raise ValueError("manifest and ground truth corpus IDs differ")  # noqa: EM101, TRY003
    truth_by_case = {case.case_id: case for case in ground_truth.cases}
    manifest_ids = {case.case_id for case in manifest.cases}
    if set(truth_by_case) != manifest_ids or set(observations) != manifest_ids:
        raise ValueError(  # noqa: TRY003
            "manifest, ground truth, and observations must contain the same cases"  # noqa: EM101
        )
    results: list[CaseResult] = []
    for case in manifest.cases:
        truth = truth_by_case[case.case_id]
        candidate = observations[case.case_id]
        _validate_case_inputs(case, truth, candidate, manifest.provenance)
        results.append(
            _case_result(
                truth,
                candidate,
                manifest.provenance,
                manifest.pass_match_tolerance_ms,
            )
        )
    ground_truth_passes = sum(item.ground_truth_passes for item in results)
    eligible_passes = sum(item.eligible_passes for item in results)
    unflagged_switches = sum(item.unflagged_switches for item in results)
    errors = [error for item in results for error in item.timing_errors]
    coverage = eligible_passes / ground_truth_passes if ground_truth_passes else 0.0
    return BenchmarkReport(
        contractVersion="subject-benchmark.v1",
        corpusId=manifest.corpus_id,
        provenance=manifest.provenance,
        passed=(unflagged_switches == 0 and coverage >= manifest.required_coverage),
        coverage=CoverageMetrics(
            eligiblePasses=eligible_passes,
            groundTruthPasses=ground_truth_passes,
            ratio=coverage,
        ),
        gaps=GapMetrics(
            timely=sum(item.timely_gaps for item in results),
            missed=sum(item.missed_gaps for item in results),
            premature=sum(item.premature_gaps for item in results),
        ),
        identity=IdentityMetrics(unflaggedSwitches=unflagged_switches),
        timing=GateTimingMetrics(
            count=len(errors),
            meanMs=mean(errors) if errors else None,
            medianMs=median(errors) if errors else None,
            maxAbsoluteMs=max((abs(error) for error in errors), default=None),
        ),
    )
