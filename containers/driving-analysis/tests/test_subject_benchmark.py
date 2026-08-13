import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import TypeAdapter, ValidationError

from driving_analysis_service import subject_benchmark, subject_benchmark_cli
from driving_analysis_service.benchmark import (
    CandidatePass,
    _candidate_passes,
    _crossing,
    _gap_counts,
    _intersection_over_union,
    _matching_pass,
    evaluate_benchmark,
)
from driving_analysis_service.contracts import (
    AcceptedSubjectObservations,
    BenchmarkCase,
    BenchmarkProvenance,
    BenchmarkReport,
    CornerGates,
    CorpusManifest,
    CorpusRecording,
    DirectedGate,
    GroundTruth,
    GroundTruthCase,
    GroundTruthPass,
    NormalizedBox,
    NormalizedPoint,
    RationalValue,
    SafeError,
    SubjectIdentityAnnotation,
    SubjectObservation,
    SubjectObservationEnvelope,
    SubjectProvenance,
    SubjectSeed,
    TrackingGap,
)
from driving_analysis_service.subject_benchmark_cli import _read, _write, main

FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "subject-benchmark"

PROVENANCE = SubjectProvenance(
    provider="synthetic",
    model="fixture",
    modelVersion="1",
    modelDigest="4" * 64,
    pipelineVersion="subject-benchmark.v1",
    configurationDigest="0" * 64,
    identityConfidenceThreshold=0.5,
    confidenceCalibration="synthetic-linear-v1",
)

BENCHMARK_PROVENANCE = BenchmarkProvenance(
    dockerImageDigest="2" * 64,
    pythonLockfileDigest="3" * 64,
    ffmpegVersion="7.1",
    provider="synthetic",
    model="fixture",
    modelVersion="1",
    modelDigest="4" * 64,
    pipelineVersion="subject-benchmark.v1",
    configurationDigest="0" * 64,
    identityConfidenceThreshold=0.5,
    confidenceCalibration="synthetic-linear-v1",
    identityMatchIouThreshold=0.5,
    identityAnnotationToleranceMs=50,
    maximumObservationIntervalMs=250,
)


def box_at(center_x: float, center_y: float = 0.42) -> NormalizedBox:
    return NormalizedBox(
        x=center_x - 0.02,
        y=center_y - 0.02,
        width=0.04,
        height=0.04,
    )


def observation(  # noqa: PLR0913
    timestamp: int,
    center_x: float,
    *,
    center_y: float = 0.42,
    frame_index: int | None = None,
    confidence: float = 1.0,
    visibility: str = "visible",
    provenance: SubjectProvenance = PROVENANCE,
) -> SubjectObservation:
    box = box_at(center_x, center_y)
    return SubjectObservation.model_validate(
        {
            "timestampMs": timestamp,
            "frameIndex": timestamp if frame_index is None else frame_index,
            "box": box.model_dump(),
            "center": {"x": center_x, "y": center_y},
            "visibility": visibility,
            "identityConfidence": confidence,
            "origin": "detected",
            "provenance": provenance.model_dump(by_alias=True),
        }
    )


def annotation(timestamp: int, center_x: float) -> SubjectIdentityAnnotation:
    return SubjectIdentityAnnotation(
        timestampMs=timestamp,
        frameIndex=timestamp,
        box=box_at(center_x),
    )


def gates() -> CornerGates:
    return CornerGates(
        entry=DirectedGate(
            entry=NormalizedPoint(x=0.4, y=0.2),
            exit=NormalizedPoint(x=0.4, y=0.8),
            direction="negative",
        ),
        exit=DirectedGate(
            entry=NormalizedPoint(x=0.6, y=0.2),
            exit=NormalizedPoint(x=0.6, y=0.8),
            direction="negative",
        ),
    )


def corpus() -> tuple[
    CorpusManifest, GroundTruth, dict[str, AcceptedSubjectObservations]
]:
    case = BenchmarkCase(
        caseId="case-a",
        recordingId="recording-a",
        windowStartMs=0,
        windowEndMs=1_000,
        subjectSeed=SubjectSeed(
            timestampMs=0,
            frameIndex=0,
            identity="subject",
            box=box_at(0.2),
        ),
    )
    truth = GroundTruth(
        contractVersion="subject-benchmark.v1",
        corpusId="fixture-corpus",
        cases=(
            GroundTruthCase(
                caseId="case-a",
                subjectIdentity="subject",
                identityAnnotations=(
                    annotation(0, 0.2),
                    annotation(200, 0.5),
                    annotation(400, 0.8),
                ),
                gates={"corner-1": gates()},
                passes=(
                    GroundTruthPass(
                        passId="pass-1",
                        cornerId="corner-1",
                        entryTimestampMs=100,
                        exitTimestampMs=300,
                    ),
                ),
            ),
        ),
    )
    manifest = CorpusManifest(
        contractVersion="subject-benchmark.v1",
        corpusId="fixture-corpus",
        recordings=(
            CorpusRecording(
                recordingId="recording-a",
                checksumSha256="5" * 64,
                byteCount=1_000,
                durationMs=1_000,
                width=1_920,
                height=1_080,
                videoCodec="h264",
                containerFormats=("mov",),
                averageFrameRate=RationalValue(numerator=30, denominator=1),
            ),
        ),
        cases=(case,),
        passMatchToleranceMs=100,
        provenance=BENCHMARK_PROVENANCE,
    )
    candidates = {
        "case-a": AcceptedSubjectObservations(
            contractVersion="subject-observation.v1",
            outcome="accepted",
            caseId="case-a",
            observations=(
                observation(0, 0.2),
                observation(200, 0.5),
                observation(400, 0.8),
            ),
        )
    }
    return manifest, truth, candidates


def test_contracts_are_strict_immutable_and_serializable() -> None:
    manifest, truth, candidates = corpus()
    assert (
        manifest.model_dump(by_alias=True)["contractVersion"] == "subject-benchmark.v1"
    )
    with pytest.raises(ValidationError):
        candidates["case-a"].observations[0].timestamp_ms = 1  # type: ignore[misc]
    assert truth.cases[0].subject_identity == "subject"
    assert subject_benchmark.evaluate_benchmark is evaluate_benchmark

    report = evaluate_benchmark(manifest, truth, candidates)
    invalid = report.model_dump(by_alias=True)
    invalid["coverage"]["unexpected"] = 1
    with pytest.raises(ValidationError):
        BenchmarkReport.model_validate(invalid)
    with pytest.raises(ValidationError, match="disallowed detail"):
        SafeError(
            code="INTERNAL_ERROR",
            stage="request",
            message="https://private.example/token",
        )


@pytest.mark.parametrize(
    "bad",
    [
        {"x": 0.9, "y": 0.9, "width": 0.2, "height": 0.1},
        {"x": 0.1, "y": 0.1, "width": 0.0, "height": 0.1},
        {"x": float("nan"), "y": 0.1, "width": 0.1, "height": 0.1},
    ],
)
def test_geometry_rejects_invalid_or_nonfinite_values(bad: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        NormalizedBox.model_validate(bad)


def test_center_and_observation_ordering_are_strict() -> None:
    invalid_center = observation(1, 0.2).model_dump(by_alias=True)
    invalid_center["center"] = {"x": 0.3, "y": 0.42}
    with pytest.raises(ValidationError, match="center"):
        SubjectObservation.model_validate(invalid_center)

    first = observation(1, 0.2, frame_index=1)
    invalid_pairs = (
        (first, observation(1, 0.3, frame_index=2)),
        (first, observation(2, 0.3, frame_index=1)),
        (observation(2, 0.2, frame_index=2), first),
    )
    for observations in invalid_pairs:
        with pytest.raises(ValidationError, match="strictly ordered"):
            AcceptedSubjectObservations(
                contractVersion="subject-observation.v1",
                outcome="accepted",
                caseId="x",
                observations=observations,
            )

    with pytest.raises(ValidationError, match="ordered and non-overlapping"):
        AcceptedSubjectObservations(
            contractVersion="subject-observation.v1",
            outcome="accepted",
            caseId="x",
            observations=(first,),
            gaps=(
                TrackingGap(startTimestampMs=10, endTimestampMs=20, reason="missing"),
                TrackingGap(startTimestampMs=19, endTimestampMs=30, reason="missing"),
            ),
        )
    with pytest.raises(ValidationError, match="must not contain observations"):
        AcceptedSubjectObservations(
            contractVersion="subject-observation.v1",
            outcome="accepted",
            caseId="x",
            observations=(first,),
            gaps=(TrackingGap(startTimestampMs=0, endTimestampMs=2, reason="missing"),),
        )


def test_ground_truth_and_manifest_reject_inconsistent_structure() -> None:
    manifest, truth, _ = corpus()
    case = truth.cases[0]
    with pytest.raises(ValidationError, match="distinct"):
        DirectedGate(
            entry=NormalizedPoint(x=0.5, y=0.5),
            exit=NormalizedPoint(x=0.5, y=0.5),
            direction="positive",
        )
    with pytest.raises(ValidationError, match="positive duration"):
        TrackingGap(startTimestampMs=10, endTimestampMs=10, reason="missing")
    with pytest.raises(ValidationError, match="window"):
        BenchmarkCase.model_validate(
            {
                **manifest.cases[0].model_dump(by_alias=True),
                "windowStartMs": 10,
                "windowEndMs": 5,
            }
        )
    with pytest.raises(ValidationError, match="seed"):
        BenchmarkCase.model_validate(
            {
                **manifest.cases[0].model_dump(by_alias=True),
                "subjectSeed": {
                    **manifest.cases[0].subject_seed.model_dump(by_alias=True),
                    "timestampMs": 1_001,
                },
            }
        )
    with pytest.raises(ValidationError, match="pass must be ordered"):
        GroundTruthPass(
            passId="unordered",
            cornerId="corner-1",
            entryTimestampMs=10,
            exitTimestampMs=10,
        )
    with pytest.raises(ValidationError, match="unknown corner"):
        case.model_copy(
            update={
                "passes": (
                    GroundTruthPass(
                        passId="unknown",
                        cornerId="missing",
                        entryTimestampMs=1,
                        exitTimestampMs=2,
                    ),
                )
            }
        ).model_validate(
            {
                **case.model_dump(by_alias=True),
                "passes": [
                    {
                        "passId": "unknown",
                        "cornerId": "missing",
                        "entryTimestampMs": 1,
                        "exitTimestampMs": 2,
                    }
                ],
            }
        )
    duplicate_manifest = manifest.model_dump(by_alias=True, mode="json")
    duplicate_manifest["cases"].append(duplicate_manifest["cases"][0])
    with pytest.raises(ValidationError, match="case IDs"):
        CorpusManifest.model_validate(duplicate_manifest)
    duplicate_recording = manifest.model_dump(by_alias=True, mode="json")
    duplicate_recording["recordings"].append(duplicate_recording["recordings"][0])
    with pytest.raises(ValidationError, match="recording IDs"):
        CorpusManifest.model_validate(duplicate_recording)
    unknown_recording = manifest.model_dump(by_alias=True, mode="json")
    unknown_recording["cases"][0]["recordingId"] = "missing"
    with pytest.raises(ValidationError, match="unknown recording"):
        CorpusManifest.model_validate(unknown_recording)
    duplicate_truth = truth.model_dump(by_alias=True, mode="json")
    duplicate_truth["cases"].append(duplicate_truth["cases"][0])
    with pytest.raises(ValidationError, match="case IDs"):
        GroundTruth.model_validate(duplicate_truth)
    too_low = manifest.model_dump(by_alias=True)
    too_low["requiredCoverage"] = 0.79
    with pytest.raises(ValidationError):
        CorpusManifest.model_validate(too_low)


def test_ground_truth_rejects_duplicate_or_unordered_annotations_and_passes() -> None:
    _, truth, _ = corpus()
    raw = truth.cases[0].model_dump(by_alias=True)
    raw["passes"] = [raw["passes"][0], raw["passes"][0]]
    with pytest.raises(ValidationError, match="pass IDs"):
        GroundTruthCase.model_validate(raw)
    raw = truth.cases[0].model_dump(by_alias=True)
    raw["passes"] = [
        {
            "passId": "later",
            "cornerId": "corner-1",
            "entryTimestampMs": 20,
            "exitTimestampMs": 30,
        },
        {
            "passId": "earlier",
            "cornerId": "corner-1",
            "entryTimestampMs": 10,
            "exitTimestampMs": 15,
        },
    ]
    with pytest.raises(ValidationError, match="passes must be strictly ordered"):
        GroundTruthCase.model_validate(raw)
    raw = truth.cases[0].model_dump(by_alias=True)
    raw["identityAnnotations"][1]["frameIndex"] = 0
    with pytest.raises(ValidationError, match="annotations"):
        GroundTruthCase.model_validate(raw)
    raw = truth.cases[0].model_dump(by_alias=True)
    raw["ambiguousSpans"] = [
        {"startTimestampMs": 10, "endTimestampMs": 20, "reason": "missing"},
        {"startTimestampMs": 19, "endTimestampMs": 30, "reason": "missing"},
    ]
    with pytest.raises(ValidationError, match="ambiguous spans"):
        GroundTruthCase.model_validate(raw)


def test_crossing_geometry_direction_and_pairing() -> None:
    negative_gate = gates().entry
    assert _crossing(observation(0, 0.2), observation(100, 0.2), negative_gate) is None
    short_gate = DirectedGate(
        entry=NormalizedPoint(x=0.4, y=0.2),
        exit=NormalizedPoint(x=0.4, y=0.6),
        direction="negative",
    )
    assert (
        _crossing(
            observation(0, 0.2, center_y=0.82),
            observation(100, 0.6, center_y=0.82),
            short_gate,
        )
        is None
    )
    positive_gate = negative_gate.model_copy(update={"direction": "positive"})
    assert _crossing(observation(0, 0.2), observation(100, 0.6), positive_gate) is None
    assert _crossing(
        observation(0, 0.6), observation(100, 0.2), positive_gate
    ) == pytest.approx(50)
    diagonal = DirectedGate(
        entry=NormalizedPoint(x=0.2, y=0.2),
        exit=NormalizedPoint(x=0.8, y=0.8),
        direction="positive",
    )
    assert (
        _crossing(
            observation(0, 0.2, center_y=0.3),
            observation(100, 0.6, center_y=0.8),
            diagonal,
        )
        is None
    )

    candidate = AcceptedSubjectObservations(
        contractVersion="subject-observation.v1",
        outcome="accepted",
        caseId="x",
        observations=(observation(0, 0.2), observation(100, 0.5)),
    )
    assert _candidate_passes(candidate, gates(), 0.5, 250) == ()
    exit_before_entry = candidate.model_copy(
        update={
            "observations": (
                observation(0, 0.5),
                observation(100, 0.7),
                observation(200, 0.2),
                observation(300, 0.5),
            )
        }
    )
    assert _candidate_passes(exit_before_entry, gates(), 0.5, 250) == ()
    later_gap = AcceptedSubjectObservations(
        contractVersion="subject-observation.v1",
        outcome="accepted",
        caseId="x",
        observations=(
            observation(0, 0.2),
            observation(100, 0.5),
            observation(200, 0.8),
        ),
        gaps=(TrackingGap(startTimestampMs=300, endTimestampMs=350, reason="missing"),),
    )
    assert len(_candidate_passes(later_gap, gates(), 0.5, 250)) == 1
    discontinuous = AcceptedSubjectObservations(
        contractVersion="subject-observation.v1",
        outcome="accepted",
        caseId="x",
        observations=(observation(0, 0.2), observation(400, 0.8)),
    )
    assert _candidate_passes(discontinuous, gates(), 0.5, 250) == ()


def test_iou_and_identity_switches_use_independent_annotations() -> None:
    assert _intersection_over_union(box_at(0.2), box_at(0.2)) == pytest.approx(1.0)
    assert _intersection_over_union(box_at(0.2), box_at(0.8)) == 0.0
    manifest, truth, candidates = corpus()
    wrong = (
        observation(0, 0.2),
        observation(200, 0.7),
        observation(400, 0.6),
    )
    candidates["case-a"] = candidates["case-a"].model_copy(
        update={"observations": wrong}
    )
    report = evaluate_benchmark(manifest, truth, candidates)
    assert report.identity.unflagged_switches == 1
    assert report.passed is False

    shifted = candidates["case-a"].model_copy(
        update={
            "observations": (
                observation(0, 0.2),
                observation(200, 0.7, frame_index=201),
                observation(400, 0.8),
            )
        }
    )
    assert (
        evaluate_benchmark(
            manifest, truth, {"case-a": shifted}
        ).identity.unflagged_switches
        == 1
    )
    missing = AcceptedSubjectObservations(
        contractVersion="subject-observation.v1",
        outcome="accepted",
        caseId="case-a",
        observations=(observation(0, 0.2), observation(400, 0.8)),
        gaps=(
            TrackingGap(
                startTimestampMs=150,
                endTimestampMs=250,
                reason="ambiguous-identity",
            ),
        ),
    )
    assert (
        evaluate_benchmark(
            manifest, truth, {"case-a": missing}
        ).identity.unflagged_switches
        == 0
    )


def test_untrusted_observation_is_not_bridged_into_an_eligible_pass() -> None:
    manifest, truth, candidates = corpus()
    uncertain = observation(200, 0.5, confidence=0.2, visibility="uncertain")
    candidates["case-a"] = candidates["case-a"].model_copy(
        update={
            "observations": (
                observation(0, 0.2),
                uncertain,
                observation(400, 0.8),
            )
        }
    )
    report = evaluate_benchmark(manifest, truth, candidates)
    assert report.coverage.eligible_passes == 0
    assert report.identity.unflagged_switches == 1


def test_pass_overlapping_an_interior_gap_is_ineligible() -> None:
    manifest, truth, _ = corpus()
    gap = TrackingGap(
        startTimestampMs=150,
        endTimestampMs=250,
        reason="ambiguous-identity",
    )
    candidate = AcceptedSubjectObservations(
        contractVersion="subject-observation.v1",
        outcome="accepted",
        caseId="case-a",
        observations=(
            observation(0, 0.2),
            observation(100, 0.5),
            observation(300, 0.5),
            observation(400, 0.8),
        ),
        gaps=(gap,),
    )
    truth = truth.model_copy(
        update={
            "cases": (truth.cases[0].model_copy(update={"ambiguous_spans": (gap,)}),)
        }
    )
    report = evaluate_benchmark(manifest, truth, {"case-a": candidate})
    assert report.coverage.eligible_passes == 0
    assert report.gaps.timely == 1
    assert report.identity.unflagged_switches == 0
    assert report.passed is False


def test_passes_after_first_gap_are_excluded_without_reidentification() -> None:
    candidate = AcceptedSubjectObservations(
        contractVersion="subject-observation.v1",
        outcome="accepted",
        caseId="case-a",
        observations=(
            observation(0, 0.2),
            observation(50, 0.2),
            observation(200, 0.5),
            observation(400, 0.8),
        ),
        gaps=(
            TrackingGap(
                startTimestampMs=10,
                endTimestampMs=20,
                reason="ambiguous-identity",
            ),
        ),
    )
    assert _candidate_passes(candidate, gates(), 0.5, 250) == ()


def test_missed_known_ambiguity_fails_qualification() -> None:
    manifest, truth, candidates = corpus()
    truth = truth.model_copy(
        update={
            "cases": (
                truth.cases[0].model_copy(
                    update={
                        "ambiguous_spans": (
                            TrackingGap(
                                startTimestampMs=500,
                                endTimestampMs=600,
                                reason="ambiguous-identity",
                            ),
                        )
                    }
                ),
            )
        }
    )
    report = evaluate_benchmark(manifest, truth, candidates)
    assert report.gaps.missed == 1
    assert report.passed is False


def test_benchmark_passes_and_reports_timing_distribution() -> None:
    manifest, truth, candidates = corpus()
    report = evaluate_benchmark(manifest, truth, candidates)
    assert report.passed is True
    assert report.coverage.ratio == 1.0
    assert report.timing.count == 2
    assert report.timing.mean_ms == pytest.approx(0)
    assert report.timing.median_ms == report.timing.mean_ms
    assert report.timing.max_absolute_ms == pytest.approx(33.3333333333)


def test_pass_matching_uses_timing_window_and_never_reuses_a_crossing() -> None:
    candidates = (
        CandidatePass(entry_ms=100, exit_ms=200),
        CandidatePass(entry_ms=300, exit_ms=400),
    )
    expected = GroundTruthPass(
        passId="second", cornerId="corner", entryTimestampMs=300, exitTimestampMs=400
    )
    match = _matching_pass(expected, candidates, set(), 0)
    assert match == (1, candidates[1])
    assert _matching_pass(expected, candidates, {1}, 0) is None
    missed = GroundTruthPass(
        passId="missed", cornerId="corner", entryTimestampMs=10, exitTimestampMs=20
    )
    assert _matching_pass(missed, candidates, set(), 5) is None


def test_gap_metrics_distinguish_timely_missed_and_premature() -> None:
    truth_gaps = (
        TrackingGap(startTimestampMs=100, endTimestampMs=200, reason="occluded"),
        TrackingGap(startTimestampMs=400, endTimestampMs=500, reason="missing"),
    )
    candidate_gaps = (
        TrackingGap(startTimestampMs=90, endTimestampMs=150, reason="occluded"),
        TrackingGap(startTimestampMs=600, endTimestampMs=700, reason="missing"),
    )
    assert _gap_counts(truth_gaps, candidate_gaps) == (1, 1, 1)


def test_empty_ground_truth_passes_produce_null_timing() -> None:
    manifest, truth, candidates = corpus()
    truth = truth.model_copy(
        update={"cases": (truth.cases[0].model_copy(update={"passes": ()}),)}
    )
    report = evaluate_benchmark(manifest, truth, candidates)
    assert report.coverage.ratio == 0.0
    assert report.timing.model_dump(by_alias=True) == {
        "count": 0,
        "meanMs": None,
        "medianMs": None,
        "maxAbsoluteMs": None,
    }
    assert report.passed is False


def test_evaluator_rejects_mismatched_or_out_of_window_inputs() -> None:
    manifest, truth, candidates = corpus()
    with pytest.raises(ValueError, match="corpus IDs"):
        evaluate_benchmark(
            manifest, truth.model_copy(update={"corpus_id": "other"}), candidates
        )
    with pytest.raises(ValueError, match="same cases"):
        evaluate_benchmark(manifest, truth, {})
    wrong_case = candidates["case-a"].model_copy(update={"case_id": "other"})
    with pytest.raises(ValueError, match="identity metadata"):
        evaluate_benchmark(manifest, truth, {"case-a": wrong_case})
    outside = candidates["case-a"].model_copy(
        update={"observations": (observation(1_001, 0.2),)}
    )
    with pytest.raises(ValueError, match="outside benchmark window"):
        evaluate_benchmark(manifest, truth, {"case-a": outside})
    outside_pass = truth.cases[0].model_copy(
        update={
            "passes": (
                GroundTruthPass(
                    passId="outside",
                    cornerId="corner-1",
                    entryTimestampMs=900,
                    exitTimestampMs=1_001,
                ),
            )
        }
    )
    with pytest.raises(ValueError, match="pass is outside"):
        evaluate_benchmark(
            manifest,
            truth.model_copy(update={"cases": (outside_pass,)}),
            candidates,
        )
    changed_provenance = PROVENANCE.model_copy(update={"model": "other"})
    wrong_provenance = candidates["case-a"].model_copy(
        update={"observations": (observation(0, 0.2, provenance=changed_provenance),)}
    )
    with pytest.raises(ValueError, match="provenance"):
        evaluate_benchmark(manifest, truth, {"case-a": wrong_provenance})


def _write_cli_inputs(
    root: Path,
    manifest: CorpusManifest,
    truth: GroundTruth,
    candidates: dict[str, AcceptedSubjectObservations],
) -> list[str]:
    manifest_path = root / "manifest.json"
    truth_path = root / "truth.json"
    observations_path = root / "observations.json"
    manifest_path.write_text(
        json.dumps(manifest.model_dump(by_alias=True, mode="json")), encoding="utf-8"
    )
    truth_path.write_text(
        json.dumps(truth.model_dump(by_alias=True, mode="json")), encoding="utf-8"
    )
    observations_path.write_text(
        json.dumps(
            [
                value.model_dump(by_alias=True, mode="json")
                for value in candidates.values()
            ]
        ),
        encoding="utf-8",
    )
    return [
        "--manifest",
        str(manifest_path),
        "--ground-truth",
        str(truth_path),
        "--observations",
        str(observations_path),
    ]


def test_cli_writes_stable_report_and_has_distinct_exit_codes(tmp_path: Path) -> None:
    manifest, truth, candidates = corpus()
    args = _write_cli_inputs(tmp_path, manifest, truth, candidates)
    output_a = tmp_path / "a.json"
    output_b = tmp_path / "b.json"
    assert main([*args, "--output", str(output_a)]) == 0
    assert main([*args, "--output", str(output_b)]) == 0
    assert output_a.read_bytes() == output_b.read_bytes()
    assert not any(
        token in output_a.read_text() for token in ("manifest.json", str(tmp_path))
    )

    observations_path = Path(args[5])
    observations_path.write_text("{}", encoding="utf-8")
    assert main([*args, "--output", str(output_a)]) == 2
    observations_path.write_text("[]", encoding="utf-8")
    assert main([*args, "--output", str(output_a)]) == 2

    failed = candidates["case-a"].model_copy(
        update={"observations": (observation(0, 0.2), observation(200, 0.2))}
    )
    observations_path.write_text(
        json.dumps([failed.model_dump(by_alias=True, mode="json")]), encoding="utf-8"
    )
    assert main([*args, "--output", str(output_a)]) == 1
    observations_path.write_text(
        json.dumps([failed.model_dump(by_alias=True, mode="json")] * 2),
        encoding="utf-8",
    )
    assert main([*args, "--output", str(output_a)]) == 2


def test_cli_bounds_input_and_redacts_parser_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    manifest, truth, candidates = corpus()
    args = _write_cli_inputs(tmp_path, manifest, truth, candidates)
    monkeypatch.setattr(subject_benchmark_cli, "MAX_BENCHMARK_INPUT_BYTES", 1)
    assert main([*args, "--output", str(tmp_path / "report.json")]) == 2
    assert capsys.readouterr().err == "invalid benchmark input: ValueError\n"

    monkeypatch.setattr(
        subject_benchmark_cli,
        "_read",
        lambda _path: (_ for _ in ()).throw(RecursionError()),
    )
    assert main([*args, "--output", str(tmp_path / "report.json")]) == 2


def test_cli_read_rejects_special_files_symlinks_and_actual_overflow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with pytest.raises(ValueError, match="regular file"):
        _read(Path(os.devnull))

    target = tmp_path / "target.json"
    target.write_text("{}", encoding="utf-8")
    link = tmp_path / "link.json"
    link.symlink_to(target)
    with pytest.raises(OSError, match="symbolic links"):
        _read(link)

    oversized = tmp_path / "oversized.json"
    oversized.write_text("[]", encoding="utf-8")
    monkeypatch.setattr(subject_benchmark_cli, "MAX_BENCHMARK_INPUT_BYTES", 1)
    monkeypatch.setattr(
        os,
        "fstat",
        lambda _descriptor: SimpleNamespace(st_mode=0o100600, st_size=0),
    )
    with pytest.raises(ValueError, match="size limit"):
        _read(oversized)


def test_atomic_output_replaces_symlinks_without_touching_their_target(
    tmp_path: Path,
) -> None:
    victim = tmp_path / "victim.json"
    victim.write_text("private", encoding="utf-8")
    output = tmp_path / "report.json"
    output.symlink_to(victim)
    _write(output, "safe\n")
    assert victim.read_text(encoding="utf-8") == "private"
    assert output.read_text(encoding="utf-8") == "safe\n"
    assert output.stat().st_mode & 0o777 == 0o600


def test_atomic_output_cleans_up_after_replace_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail_replace(_self: Path, _target: Path) -> Path:
        message = "safe test failure"
        raise OSError(message)

    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(OSError, match="safe test failure"):
        _write(tmp_path / "report.json", "safe\n")
    assert list(tmp_path.iterdir()) == []


def test_committed_contract_and_scenario_fixtures_are_executable() -> None:
    manifest = CorpusManifest.model_validate_json(
        (FIXTURE_ROOT / "manifest.json").read_text()
    )
    truth = GroundTruth.model_validate_json(
        (FIXTURE_ROOT / "ground-truth.json").read_text()
    )
    raw_observations = json.loads(
        (FIXTURE_ROOT / "accepted-observations.json").read_text()
    )
    candidates = {
        parsed.case_id: parsed
        for item in raw_observations
        if (parsed := AcceptedSubjectObservations.model_validate(item))
    }
    report = evaluate_benchmark(manifest, truth, candidates)
    expected = json.loads((FIXTURE_ROOT / "expected-report.json").read_text())
    assert report.model_dump(by_alias=True, mode="json") == expected

    index = json.loads((FIXTURE_ROOT / "scenarios.json").read_text())
    assert index["manifest"] == "manifest.json"
    for scenario in index["scenarios"]:
        case_id = scenario["caseId"]
        scenario_manifest = manifest.model_copy(
            update={
                "cases": tuple(
                    case for case in manifest.cases if case.case_id == case_id
                )
            }
        )
        scenario_truth = truth.model_copy(
            update={
                "cases": tuple(case for case in truth.cases if case.case_id == case_id)
            }
        )
        scenario_report = evaluate_benchmark(
            scenario_manifest, scenario_truth, {case_id: candidates[case_id]}
        )
        assert scenario_report.passed is scenario["expected"]["passed"]
        assert (
            scenario_report.coverage.eligible_passes
            == scenario["expected"]["eligiblePasses"]
        )
        assert (
            scenario_report.identity.unflagged_switches
            == scenario["expected"]["unflaggedSwitches"]
        )
        assert scenario_report.gaps.timely == scenario["expected"]["timelyGaps"]
    timing = next(
        item for item in index["scenarios"] if item["id"] == "gate-timing-error"
    )
    assert timing["caseId"] == "gate-timing-error"


def test_committed_rejected_envelope_is_safe_and_invalid_fixtures_are_rejected() -> (
    None
):
    adapter: TypeAdapter[SubjectObservationEnvelope] = TypeAdapter(
        SubjectObservationEnvelope
    )
    rejected = adapter.validate_json(
        (FIXTURE_ROOT / "rejected-observation.json").read_text()
    )
    assert rejected.outcome == "rejected"
    for path in sorted((FIXTURE_ROOT / "rejected").glob("*.json")):
        with pytest.raises(ValidationError):
            adapter.validate_json(path.read_text())
