import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from driving_analysis_service import subject_benchmark
from driving_analysis_service.benchmark import _crossing, evaluate_benchmark
from driving_analysis_service.contracts import (
    AcceptedSubjectObservations,
    BenchmarkCase,
    BenchmarkProvenance,
    CornerGates,
    CorpusManifest,
    DirectedGate,
    GroundTruth,
    GroundTruthCase,
    GroundTruthPass,
    NormalizedBox,
    NormalizedPoint,
    SafeError,
    SubjectObservation,
    SubjectProvenance,
    SubjectSeed,
    TrackingGap,
)
from driving_analysis_service.subject_benchmark_cli import main

PROVENANCE = SubjectProvenance(
    origin="provider",
    provider="synthetic",
    model="fixture",
    modelVersion="1",
    pipelineVersion="1",
    configurationDigest="0" * 64,
    modelDigest="1" * 64,
)


def observation(
    timestamp: int, x: float, identity: str = "subject"
) -> SubjectObservation:
    box = NormalizedBox(x=x - 0.02, y=0.4, width=0.04, height=0.04)
    return SubjectObservation(
        timestampMs=timestamp,
        frameIndex=timestamp,
        box=box,
        center=NormalizedPoint(x=x, y=0.42),
        visibility="visible",
        identityConfidence=1.0,
        identity=identity,
        provenance=PROVENANCE,
    )


def corpus() -> tuple[
    CorpusManifest, GroundTruth, dict[str, AcceptedSubjectObservations]
]:
    case = BenchmarkCase(
        caseId="case-a",
        windowStartMs=0,
        windowEndMs=1_000,
        subjectSeed=SubjectSeed(
            timestampMs=0,
            identity="subject",
            box=NormalizedBox(x=0.08, y=0.4, width=0.04, height=0.04),
        ),
    )
    gate = DirectedGate(
        entry=NormalizedPoint(x=0.4, y=0.2),
        exit=NormalizedPoint(x=0.4, y=0.8),
        direction="negative",
    )
    exit_gate = DirectedGate(
        entry=NormalizedPoint(x=0.6, y=0.2),
        exit=NormalizedPoint(x=0.6, y=0.8),
        direction="negative",
    )
    truth = GroundTruth(
        contractVersion="subject-benchmark.v1",
        corpusId="fixture-corpus",
        cases=(
            GroundTruthCase(
                caseId="case-a",
                subjectIdentity="subject",
                gates={"corner-1": CornerGates(entry=gate, exit=exit_gate)},
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
        cases=(case,),
        provenance=BenchmarkProvenance(
            dockerImageDigest="2" * 64,
            pythonLockfileDigest="3" * 64,
            ffmpegVersion="7.1",
            modelDigest="4" * 64,
            pipelineVersion="subject-benchmark.v1",
        ),
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


def test_valid_contracts_are_immutable_and_serializable() -> None:
    manifest, truth, candidates = corpus()
    assert (
        manifest.model_dump(by_alias=True)["contractVersion"] == "subject-benchmark.v1"
    )
    with pytest.raises(ValidationError):
        candidates["case-a"].observations[0].timestamp_ms = 1  # type: ignore[misc]
    assert truth.model_dump(by_alias=True)["cases"][0]["caseId"] == "case-a"


@pytest.mark.parametrize(
    "bad",
    [
        {"x": 0.9, "y": 0.9, "width": 0.2, "height": 0.1},
        {"x": 0.1, "y": 0.1, "width": 0.0, "height": 0.1},
    ],
)
def test_geometry_is_strict(bad: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        NormalizedBox.model_validate(bad)


def test_ordering_and_center_validation() -> None:
    with pytest.raises(ValidationError):
        SubjectObservation(
            timestampMs=1,
            frameIndex=1,
            box=NormalizedBox(x=0.18, y=0.4, width=0.04, height=0.04),
            center=NormalizedPoint(x=0.3, y=0.42),
            visibility="visible",
            identityConfidence=1.0,
            identity="subject",
            provenance=PROVENANCE,
        )
    with pytest.raises(ValidationError):
        AcceptedSubjectObservations(
            contractVersion="subject-observation.v1",
            outcome="accepted",
            caseId="x",
            observations=(observation(2, 0.2), observation(1, 0.3)),
        )


def test_gap_requires_positive_ordered_span() -> None:
    with pytest.raises(ValidationError):
        TrackingGap(startTimestampMs=10, endTimestampMs=10, reason="missing")


def test_gates_windows_and_safe_errors_reject_unsafe_values() -> None:
    with pytest.raises(ValidationError):
        DirectedGate(
            entry=NormalizedPoint(x=0.5, y=0.5),
            exit=NormalizedPoint(x=0.5, y=0.5),
            direction="positive",
        )
    with pytest.raises(ValidationError):
        BenchmarkCase(
            caseId="x",
            windowStartMs=10,
            windowEndMs=5,
            subjectSeed=SubjectSeed(
                timestampMs=10,
                identity="x",
                box=NormalizedBox(x=0.1, y=0.1, width=0.1, height=0.1),
            ),
        )
    with pytest.raises(ValidationError):
        BenchmarkCase(
            caseId="x",
            windowStartMs=0,
            windowEndMs=5,
            subjectSeed=SubjectSeed(
                timestampMs=6,
                identity="x",
                box=NormalizedBox(x=0.1, y=0.1, width=0.1, height=0.1),
            ),
        )
    with pytest.raises(ValidationError):
        GroundTruthPass(passId="x", cornerId="x", entryTimestampMs=5, exitTimestampMs=5)
    with pytest.raises(ValidationError):
        SafeError(
            code="INTERNAL_ERROR",
            stage="request",
            message="https://private.example/token",
        )


def test_benchmark_passes_and_interpolates_timing() -> None:
    manifest, truth, candidates = corpus()
    report = evaluate_benchmark(manifest, truth, candidates)
    assert report.passed is True
    assert report.coverage["ratio"] == 1.0
    assert report.timing["meanMs"] == pytest.approx(-66.6666666667)
    assert report.provenance.pipeline_version == "subject-benchmark.v1"


def test_crossing_rejects_non_crossings_and_wrong_direction() -> None:
    manifest, _, _ = corpus()
    gate = DirectedGate(
        entry=NormalizedPoint(x=0.4, y=0.2),
        exit=NormalizedPoint(x=0.4, y=0.8),
        direction="positive",
    )
    assert _crossing(observation(0, 0.2), observation(100, 0.2), gate) is None
    assert _crossing(observation(0, 0.2), observation(100, 0.3), gate) is None
    assert _crossing(observation(0, 0.3), observation(100, 0.5), gate) is None
    assert subject_benchmark.evaluate_benchmark is evaluate_benchmark
    assert manifest.corpus_id == "fixture-corpus"


def test_switch_fails_even_with_coverage() -> None:
    manifest, truth, candidates = corpus()
    candidates["case-a"] = candidates["case-a"].model_copy(
        update={
            "observations": (
                observation(0, 0.2),
                observation(200, 0.5, "other"),
                observation(400, 0.8),
            )
        }
    )
    report = evaluate_benchmark(manifest, truth, candidates)
    assert report.passed is False
    assert report.identity["unflaggedSwitches"] == 1


def test_untrusted_switch_requires_a_gap() -> None:
    manifest, truth, candidates = corpus()
    changed = observation(200, 0.5, "other").model_copy(
        update={"identity_confidence": 0.2, "visibility": "uncertain"}
    )
    candidates["case-a"] = candidates["case-a"].model_copy(
        update={"observations": (observation(0, 0.2), changed, observation(400, 0.8))}
    )
    assert (
        evaluate_benchmark(manifest, truth, candidates).identity["unflaggedSwitches"]
        == 1
    )
    candidates["case-a"] = candidates["case-a"].model_copy(
        update={
            "gaps": (
                TrackingGap(
                    startTimestampMs=150,
                    endTimestampMs=250,
                    reason="ambiguous-identity",
                ),
            )
        }
    )
    assert (
        evaluate_benchmark(manifest, truth, candidates).identity["unflaggedSwitches"]
        == 0
    )


def test_gap_makes_pass_ineligible_and_eighty_percent_is_inclusive() -> None:
    manifest, truth, candidates = corpus()
    candidates["case-a"] = candidates["case-a"].model_copy(
        update={
            "gaps": (
                TrackingGap(
                    startTimestampMs=150, endTimestampMs=250, reason="occluded"
                ),
            )
        }
    )
    report = evaluate_benchmark(manifest, truth, candidates)
    assert report.coverage["eligiblePasses"] == 0
    assert report.passed is False
    assert manifest.required_coverage == 0.8
    assert report.gaps == {"timely": 0, "missed": 0, "premature": 1}


def test_mismatched_inputs_are_rejected() -> None:
    manifest, truth, candidates = corpus()
    with pytest.raises(ValueError, match="corpus IDs"):
        evaluate_benchmark(
            manifest, truth.model_copy(update={"corpus_id": "other"}), candidates
        )
    with pytest.raises(ValueError, match="same cases"):
        evaluate_benchmark(manifest, truth, {})
    outside = candidates["case-a"].model_copy(
        update={"observations": (observation(1_001, 0.2),)}
    )
    with pytest.raises(ValueError, match="outside benchmark window"):
        evaluate_benchmark(manifest, truth, {"case-a": outside})
    gap_outside = candidates["case-a"].model_copy(
        update={
            "gaps": (
                TrackingGap(
                    startTimestampMs=900, endTimestampMs=1_001, reason="missing"
                ),
            )
        }
    )
    with pytest.raises(ValueError, match="outside benchmark window"):
        evaluate_benchmark(manifest, truth, {"case-a": gap_outside})


def test_ground_truth_rejects_unknown_corner_reference() -> None:
    with pytest.raises(ValidationError, match="unknown corner"):
        GroundTruthCase(
            caseId="case-a",
            subjectIdentity="subject",
            gates={},
            passes=(
                GroundTruthPass(
                    passId="pass",
                    cornerId="missing",
                    entryTimestampMs=1,
                    exitTimestampMs=2,
                ),
            ),
        )


def test_cli_writes_stable_report_and_exit_codes(tmp_path: Path) -> None:
    manifest, truth, candidates = corpus()
    manifest_path = tmp_path / "manifest.json"
    truth_path = tmp_path / "truth.json"
    observations_path = tmp_path / "observations.json"
    output_a = tmp_path / "a.json"
    output_b = tmp_path / "b.json"
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
    args = [
        "--manifest",
        str(manifest_path),
        "--ground-truth",
        str(truth_path),
        "--observations",
        str(observations_path),
    ]
    assert main([*args, "--output", str(output_a)]) == 0
    assert main([*args, "--output", str(output_b)]) == 0
    assert output_a.read_bytes() == output_b.read_bytes()
    assert not any(
        token in output_a.read_text() for token in ("manifest.json", str(tmp_path))
    )
    observations_path.write_text("{}", encoding="utf-8")
    assert main([*args, "--output", str(output_a)]) == 2
    failed = candidates["case-a"].model_copy(
        update={
            "observations": (
                observation(0, 0.2),
                observation(200, 0.5, "other"),
                observation(400, 0.8),
            )
        }
    )
    observations_path.write_text(
        json.dumps([failed.model_dump(by_alias=True, mode="json")]), encoding="utf-8"
    )
    assert main([*args, "--output", str(output_a)]) == 1
    observations_path.write_text(
        json.dumps(
            [
                value.model_dump(by_alias=True, mode="json")
                for value in candidates.values()
            ]
            * 2
        ),
        encoding="utf-8",
    )
    assert main([*args, "--output", str(output_a)]) == 2


def test_committed_scenario_index_and_expected_report_are_versioned() -> None:
    fixture_root = Path(__file__).parent / "fixtures" / "subject-benchmark"
    scenarios = json.loads((fixture_root / "scenarios.json").read_text())
    expected = json.loads((fixture_root / "expected-report.json").read_text())
    assert scenarios["contractVersion"] == "subject-benchmark.v1"
    assert {item["id"] for item in scenarios["scenarios"]} == {
        "trusted-tracking",
        "flagged-ambiguity-gap",
        "unflagged-identity-switch",
        "missed-corner-pass",
        "gate-timing-error",
    }
    assert expected["contractVersion"] == "subject-benchmark.v1"
