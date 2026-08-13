"""Deterministic, provider-neutral Subject-observation benchmark mechanics."""

# These messages are intentionally descriptive internal validation context; the
# CLI replaces them with the contract's redacted public error.
# ruff: noqa: EM101, EM102, TRY003, PLR0913

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
    CorpusRecording,
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
    if (
        first_side == second_side
        or (first_side < 0 and second_side < 0)
        or (first_side > 0 and second_side > 0)
    ):
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


def _is_trusted(observation: SubjectObservation, threshold: float) -> bool:
    return (
        observation.visibility == "visible"
        and observation.identity_confidence >= threshold
    )


def _crossings(
    candidate: AcceptedSubjectObservations,
    gate: DirectedGate,
    threshold: float,
    maximum_interval_ms: int,
) -> tuple[float, ...]:
    crossings: list[float] = []
    gap_index = 0
    for first, second in pairwise(candidate.observations):
        while (
            gap_index < len(candidate.gaps)
            and candidate.gaps[gap_index].end_timestamp_ms < first.timestamp_ms
        ):
            gap_index += 1
        overlaps_gap = (
            gap_index < len(candidate.gaps)
            and first.timestamp_ms <= candidate.gaps[gap_index].end_timestamp_ms
            and second.timestamp_ms >= candidate.gaps[gap_index].start_timestamp_ms
        )
        if (
            not _is_trusted(first, threshold)
            or not _is_trusted(second, threshold)
            or second.timestamp_ms - first.timestamp_ms > maximum_interval_ms
            or overlaps_gap
        ):
            continue
        crossing = _crossing(first, second, gate)
        if crossing is not None and (not crossings or crossing != crossings[-1]):
            crossings.append(crossing)
    return tuple(crossings)


def _candidate_passes(
    candidate: AcceptedSubjectObservations,
    gates: CornerGates,
    threshold: float,
    maximum_interval_ms: int,
) -> tuple[CandidatePass, ...]:
    entries = _crossings(candidate, gates.entry, threshold, maximum_interval_ms)
    exits = _crossings(candidate, gates.exit, threshold, maximum_interval_ms)
    passes: list[CandidatePass] = []
    next_exit = 0
    coverage_cutoff = candidate.gaps[0].start_timestamp_ms if candidate.gaps else None
    for entry in entries:
        if coverage_cutoff is not None and entry >= coverage_cutoff:
            break
        while next_exit < len(exits) and exits[next_exit] <= entry:
            next_exit += 1
        if next_exit == len(exits):
            break
        exit_ms = exits[next_exit]
        next_exit += 1
        if (
            candidate.gaps
            and entry <= candidate.gaps[0].end_timestamp_ms
            and exit_ms >= candidate.gaps[0].start_timestamp_ms
        ):
            continue
        passes.append(CandidatePass(entry_ms=entry, exit_ms=exit_ms))
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
    recording: CorpusRecording,
    frame_timestamp_tolerance_ms: int,
) -> int:
    switches = 0
    switch_active = False
    observation_index = 0
    candidate_gap_index = 0
    truth_gap_index = 0
    for annotation in truth.identity_annotations:
        while (
            observation_index + 1 < len(candidate.observations)
            and candidate.observations[observation_index + 1].timestamp_ms
            <= annotation.timestamp_ms
        ):
            observation_index += 1
        observation = min(
            (
                item
                for item in candidate.observations
                if abs(item.timestamp_ms - annotation.timestamp_ms)
                <= provenance.identity_annotation_tolerance_ms
                and _identity_frame_match(
                    annotation.frame_index,
                    item.frame_index,
                    recording,
                    provenance.identity_annotation_tolerance_ms,
                    frame_timestamp_tolerance_ms,
                )
            ),
            key=lambda item: (
                abs(item.timestamp_ms - annotation.timestamp_ms),
                abs(item.frame_index - annotation.frame_index),
            ),
            default=None,
        )
        while (
            candidate_gap_index < len(candidate.gaps)
            and candidate.gaps[candidate_gap_index].end_timestamp_ms
            < annotation.timestamp_ms
        ):
            candidate_gap_index += 1
        while (
            truth_gap_index < len(truth.ambiguous_spans)
            and truth.ambiguous_spans[truth_gap_index].end_timestamp_ms
            < annotation.timestamp_ms
        ):
            truth_gap_index += 1
        candidate_gap_covers = (
            candidate_gap_index < len(candidate.gaps)
            and candidate.gaps[candidate_gap_index].start_timestamp_ms
            <= annotation.timestamp_ms
            <= candidate.gaps[candidate_gap_index].end_timestamp_ms
        )
        known_ambiguity = (
            truth_gap_index < len(truth.ambiguous_spans)
            and truth.ambiguous_spans[truth_gap_index].start_timestamp_ms
            <= annotation.timestamp_ms
            <= truth.ambiguous_spans[truth_gap_index].end_timestamp_ms
        )
        mismatch = (
            observation is None
            or known_ambiguity
            or not _is_trusted(observation, provenance.identity_confidence_threshold)
            or _intersection_over_union(observation.box, annotation.box)
            < provenance.identity_match_iou_threshold
        )
        if candidate_gap_covers or not mismatch:
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
    minimum_index: int = 0,
) -> tuple[int, CandidatePass] | None:
    possible = (
        (index, candidate)
        for index, candidate in enumerate(candidates)
        if index not in used
        and index >= minimum_index
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
    truth_gaps: tuple[TrackingGap, ...],
    candidate_gaps: tuple[TrackingGap, ...],
    coverage_tolerance_ms: int,
) -> tuple[int, int, int]:
    timely = 0
    candidate_index = 0
    for truth in truth_gaps:
        while (
            candidate_index < len(candidate_gaps)
            and candidate_gaps[candidate_index].end_timestamp_ms
            < truth.start_timestamp_ms
        ):
            candidate_index += 1
        if (
            candidate_index < len(candidate_gaps)
            and candidate_gaps[candidate_index].start_timestamp_ms
            <= truth.start_timestamp_ms + coverage_tolerance_ms
            and candidate_gaps[candidate_index].end_timestamp_ms
            >= truth.end_timestamp_ms - coverage_tolerance_ms
        ):
            timely += 1
    missed = len(truth_gaps) - timely
    premature = 0
    truth_index = 0
    for candidate in candidate_gaps:
        while (
            truth_index < len(truth_gaps)
            and truth_gaps[truth_index].end_timestamp_ms < candidate.start_timestamp_ms
        ):
            truth_index += 1
        overlaps = (
            truth_index < len(truth_gaps)
            and candidate.start_timestamp_ms <= truth_gaps[truth_index].end_timestamp_ms
            and candidate.end_timestamp_ms >= truth_gaps[truth_index].start_timestamp_ms
        )
        if not overlaps:
            premature += 1
    return timely, missed, premature


def _case_result(
    truth: GroundTruthCase,
    candidate: AcceptedSubjectObservations,
    provenance: BenchmarkProvenance,
    tolerance_ms: int,
    recording: CorpusRecording,
    frame_timestamp_tolerance_ms: int,
) -> CaseResult:
    passes_by_corner = {
        corner_id: _candidate_passes(
            candidate,
            gates,
            provenance.identity_confidence_threshold,
            provenance.maximum_observation_interval_ms,
        )
        for corner_id, gates in truth.gates.items()
    }
    used_by_corner: dict[str, set[int]] = {
        corner_id: set() for corner_id in truth.gates
    }
    next_candidate_by_corner = dict.fromkeys(truth.gates, 0)
    timing_errors: list[float] = []
    eligible = 0
    for expected in truth.passes:
        matched = _matching_pass(
            expected,
            passes_by_corner[expected.corner_id],
            used_by_corner[expected.corner_id],
            min(tolerance_ms, provenance.maximum_observation_interval_ms),
            next_candidate_by_corner[expected.corner_id],
        )
        if matched is None:
            continue
        index, candidate_pass = matched
        used_by_corner[expected.corner_id].add(index)
        next_candidate_by_corner[expected.corner_id] = index + 1
        eligible += 1
        timing_errors.extend(
            (
                candidate_pass.entry_ms - expected.entry_timestamp_ms,
                candidate_pass.exit_ms - expected.exit_timestamp_ms,
            )
        )
    timely, missed, premature = _gap_counts(
        truth.ambiguous_spans,
        candidate.gaps,
        provenance.ambiguity_gap_coverage_tolerance_ms,
    )
    return CaseResult(
        ground_truth_passes=len(truth.passes),
        eligible_passes=eligible,
        unflagged_switches=_unflagged_switches(
            truth,
            candidate,
            provenance,
            recording,
            frame_timestamp_tolerance_ms,
        ),
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


def _frame_timestamp_error_ms(
    timestamp_ms: int, frame_index: int, recording: CorpusRecording
) -> int:
    rate = recording.average_frame_rate
    return abs(timestamp_ms * rate.numerator - frame_index * 1000 * rate.denominator)


def _identity_frame_match(
    annotation_frame_index: int,
    observation_frame_index: int,
    recording: CorpusRecording,
    identity_tolerance_ms: int,
    frame_timestamp_tolerance_ms: int,
) -> bool:
    rate = recording.average_frame_rate
    allowed_timestamp_ms = identity_tolerance_ms + 2 * frame_timestamp_tolerance_ms
    return (
        abs(observation_frame_index - annotation_frame_index) * 1000 * rate.denominator
        <= allowed_timestamp_ms * rate.numerator
    )


def _validate_frame_reference(
    label: str,
    timestamp_ms: int,
    frame_index: int,
    recording: CorpusRecording,
    tolerance_ms: int,
) -> None:
    if frame_index >= recording.decoded_frame_count:
        raise ValueError(f"{label} frame index is outside recording")
    if (
        _frame_timestamp_error_ms(timestamp_ms, frame_index, recording)
        > tolerance_ms * recording.average_frame_rate.numerator
    ):
        raise ValueError(f"{label} timestamp and frame index are inconsistent")


def _interval_is_inside(
    start_ms: int,
    end_ms: int,
    case: BenchmarkCase,
    recording: CorpusRecording,
) -> bool:
    return (
        case.window_start_ms <= start_ms <= end_ms <= case.window_end_ms
        and end_ms <= recording.duration_ms
    )


def _validate_case_inputs(
    case: BenchmarkCase,
    truth: GroundTruthCase,
    candidate: AcceptedSubjectObservations,
    provenance: BenchmarkProvenance,
    recording: CorpusRecording,
    frame_timestamp_tolerance_ms: int,
) -> None:
    if (
        candidate.case_id != case.case_id
        or case.subject_seed.identity != truth.subject_identity
    ):
        raise ValueError("case identity metadata differs")
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
        raise ValueError("observation or gap is outside benchmark window")
    if any(
        not _interval_is_inside(
            gap.start_timestamp_ms, gap.end_timestamp_ms, case, recording
        )
        for gap in (*candidate.gaps, *truth.ambiguous_spans)
    ):
        raise ValueError("observation or gap is outside recording duration")
    if any(
        item.entry_timestamp_ms < case.window_start_ms
        or item.exit_timestamp_ms > case.window_end_ms
        for item in truth.passes
    ):
        raise ValueError("ground-truth pass is outside benchmark window")
    if any(
        not _interval_is_inside(
            item.entry_timestamp_ms, item.exit_timestamp_ms, case, recording
        )
        for item in truth.passes
    ):
        raise ValueError("ground-truth pass is outside recording duration")
    _validate_frame_reference(
        "subject seed",
        case.subject_seed.timestamp_ms,
        case.subject_seed.frame_index,
        recording,
        frame_timestamp_tolerance_ms,
    )
    for item in candidate.observations:
        _validate_frame_reference(
            "observation",
            item.timestamp_ms,
            item.frame_index,
            recording,
            frame_timestamp_tolerance_ms,
        )
    for annotation in truth.identity_annotations:
        _validate_frame_reference(
            "identity annotation",
            annotation.timestamp_ms,
            annotation.frame_index,
            recording,
            frame_timestamp_tolerance_ms,
        )
    if any(
        not _provenance_matches(provenance, item.provenance)
        for item in candidate.observations
    ):
        raise ValueError("observation provenance differs from benchmark")


def evaluate_benchmark(
    manifest: CorpusManifest,
    ground_truth: GroundTruth,
    observations: dict[str, AcceptedSubjectObservations],
) -> BenchmarkReport:
    """Evaluate stored observations without invoking inference or external services."""
    if manifest.corpus_id != ground_truth.corpus_id:
        raise ValueError("manifest and ground truth corpus IDs differ")
    truth_by_case = {case.case_id: case for case in ground_truth.cases}
    manifest_ids = {case.case_id for case in manifest.cases}
    if set(truth_by_case) != manifest_ids or set(observations) != manifest_ids:
        raise ValueError(
            "manifest, ground truth, and observations must contain the same cases"
        )
    results: list[CaseResult] = []
    recordings = {
        recording.recording_id: recording for recording in manifest.recordings
    }
    for case in manifest.cases:
        truth = truth_by_case[case.case_id]
        candidate = observations[case.case_id]
        _validate_case_inputs(
            case,
            truth,
            candidate,
            manifest.provenance,
            recordings[case.recording_id],
            manifest.frame_timestamp_tolerance_ms,
        )
        results.append(
            _case_result(
                truth,
                candidate,
                manifest.provenance,
                manifest.pass_match_tolerance_ms,
                recordings[case.recording_id],
                manifest.frame_timestamp_tolerance_ms,
            )
        )
    ground_truth_passes = sum(item.ground_truth_passes for item in results)
    eligible_passes = sum(item.eligible_passes for item in results)
    unflagged_switches = sum(item.unflagged_switches for item in results)
    missed_gaps = sum(item.missed_gaps for item in results)
    errors = [error for item in results for error in item.timing_errors]
    coverage = eligible_passes / ground_truth_passes if ground_truth_passes else 0.0
    effective_pass_match_tolerance_ms = min(
        manifest.pass_match_tolerance_ms,
        manifest.provenance.maximum_observation_interval_ms,
    )
    return BenchmarkReport(
        contractVersion="subject-benchmark.v1",
        corpusId=manifest.corpus_id,
        provenance=manifest.provenance.model_copy(
            update={
                "pass_match_tolerance_ms": effective_pass_match_tolerance_ms,
            }
        ),
        passed=(
            unflagged_switches == 0
            and missed_gaps == 0
            and coverage >= manifest.required_coverage
        ),
        coverage=CoverageMetrics(
            eligiblePasses=eligible_passes,
            groundTruthPasses=ground_truth_passes,
            ratio=coverage,
        ),
        gaps=GapMetrics(
            timely=sum(item.timely_gaps for item in results),
            missed=missed_gaps,
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
