import json
import re
from pathlib import Path
from unittest.mock import patch

import pytest
from pydantic import ValidationError

import driving_analysis_service.benchmark as benchmark_module
from driving_analysis_service.benchmark import (
    benchmark_contract_digest,
    benchmark_generation_digest,
    evaluate_representative_benchmark,
)
from driving_analysis_service.contracts import (
    BenchmarkObservationSetV2,
    GroundTruthPass,
    RepresentativeCorpusManifestV2,
    RepresentativeGroundTruthV2,
    SubjectObservation,
)
from driving_analysis_service.subject_benchmark_cli import main

FIXTURE_ROOT = (
    Path(__file__).parent / "fixtures" / "subject-benchmark" / "representative-v1"
)


def reject_duplicate_pairs(items: list[tuple[str, object]]) -> dict[str, object]:
    result = dict(items)
    assert len(result) == len(items)
    return result


def corpus() -> tuple[
    RepresentativeCorpusManifestV2,
    RepresentativeGroundTruthV2,
    BenchmarkObservationSetV2,
]:
    return (
        RepresentativeCorpusManifestV2.model_validate_json(
            (FIXTURE_ROOT / "manifest.json").read_text()
        ),
        RepresentativeGroundTruthV2.model_validate_json(
            (FIXTURE_ROOT / "ground-truth.json").read_text()
        ),
        BenchmarkObservationSetV2.model_validate_json(
            (FIXTURE_ROOT / "reference-observations.json").read_text()
        ),
    )


def bind(
    manifest: RepresentativeCorpusManifestV2,
    truth: RepresentativeGroundTruthV2,
    observations: BenchmarkObservationSetV2,
) -> BenchmarkObservationSetV2:
    bound = observations.model_copy(
        update={
            "manifest_digest": benchmark_contract_digest(manifest),
            "ground_truth_digest": benchmark_contract_digest(truth),
        }
    )
    return bound.model_copy(
        update={"generation_digest": benchmark_generation_digest(bound)}
    )


def test_representative_fixture_is_safe_complete_and_deterministic(
    tmp_path: Path,
) -> None:
    manifest, truth, observations = corpus()
    report = evaluate_representative_benchmark(manifest, truth, observations)
    expected = (FIXTURE_ROOT / "expected-report.json").read_bytes()

    assert len(manifest.recordings) == len(manifest.cases) == len(truth.cases) == 3
    assert all(
        case.representative_facts.complete_race_window for case in manifest.cases
    )
    assert report.passed
    assert report.identity.unflagged_switches == 0
    assert report.coverage.ratio >= 0.8
    assert report.model_dump_json() != ""
    assert report.evidence.manifest_digest == observations.manifest_digest
    assert report.evidence.ground_truth_digest == observations.ground_truth_digest
    assert report.evidence.generation_digest == observations.generation_digest

    args = [
        "--manifest",
        str(FIXTURE_ROOT / "manifest.json"),
        "--ground-truth",
        str(FIXTURE_ROOT / "ground-truth.json"),
        "--observations",
        str(FIXTURE_ROOT / "reference-observations.json"),
    ]
    first = tmp_path / "first.json"
    second = tmp_path / "second.json"
    assert main([*args, "--output", str(first)]) == 0
    assert main([*args, "--output", str(second)]) == 0
    assert first.read_bytes() == second.read_bytes() == expected

    assert {path.name for path in FIXTURE_ROOT.iterdir()} == {
        "README.md",
        "expected-report.json",
        "ground-truth.json",
        "manifest.json",
        "reference-observations.json",
    }
    for path in FIXTURE_ROOT.iterdir():
        assert path.suffix in {".json", ".md"}
        content = path.read_text(encoding="utf-8")
        assert "videos/" not in content
        assert not re.search(r"(?i)\b(?:file|https?|s3|r2)://", content)
        assert not re.search(
            r"(?i)(?:^|[\s\"'])(?:\.\.?/|/(?:home|users|mnt|media|tmp|var/tmp)/|[a-z]:\\)",
            content,
        )
        assert not re.search(r"(?i)\.(?:mov|mp4|mkv|avi|webm)(?:\b|\")", content)
        assert not re.search(
            r"(?i)\b(?:api[_-]?key|access[_-]?token|authorization|bearer|password|secret)\b\s*[:=]",
            content,
        )


def test_representative_contract_rejects_incomplete_metadata() -> None:
    manifest, _, observations = corpus()
    raw = manifest.model_dump(by_alias=True, mode="json")
    raw["recordings"][0]["framing"]["trackViewY"] = 0.25
    with pytest.raises(ValidationError, match="fixed bottom two-thirds"):
        RepresentativeCorpusManifestV2.model_validate(raw)

    raw = manifest.model_dump(by_alias=True, mode="json")
    raw["recordings"][0]["width"] = 1280
    with pytest.raises(ValidationError, match="exactly 16:9"):
        RepresentativeCorpusManifestV2.model_validate(raw)

    raw = manifest.model_dump(by_alias=True, mode="json")
    raw["cases"][0]["representativeFacts"]["similarLookingCompetitorCount"] = 7
    with pytest.raises(ValidationError, match="fewer than the field"):
        RepresentativeCorpusManifestV2.model_validate(raw)

    raw = manifest.model_dump(by_alias=True, mode="json")
    raw["cases"][0]["representativeFacts"]["identityChallenges"] = [
        "occlusion",
        "occlusion",
    ]
    with pytest.raises(ValidationError, match="must be unique"):
        RepresentativeCorpusManifestV2.model_validate(raw)

    raw = observations.model_dump(by_alias=True, mode="json")
    raw["cases"][1]["caseId"] = raw["cases"][0]["caseId"]
    with pytest.raises(ValidationError, match="case IDs"):
        BenchmarkObservationSetV2.model_validate(raw)

    raw = manifest.model_dump(by_alias=True, mode="json")
    raw["frameTimestampToleranceMs"] = 17
    with pytest.raises(ValidationError, match="half a frame"):
        RepresentativeCorpusManifestV2.model_validate(raw)


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("recordings", "three recording windows"),
        ("identities", "identities must be distinct"),
        ("densities", "field densities must differ"),
        ("competitors", "similar-looking competitor"),
        ("challenges", "both identity challenges"),
        ("case_ids", "case IDs must be unique"),
        ("unknown_recording", "unknown recording"),
        ("window", "window exceeds recording duration"),
    ],
)
def test_representative_manifest_enforces_corpus_diversity(
    mutation: str, message: str
) -> None:
    manifest, _, _ = corpus()
    raw = manifest.model_dump(by_alias=True, mode="json")
    if mutation == "recordings":
        raw["cases"][1]["recordingId"] = "recording-a"
        raw["cases"][2]["recordingId"] = "recording-a"
    elif mutation == "identities":
        raw["cases"][1]["subjectSeed"]["identity"] = "subject-a"
    elif mutation == "densities":
        raw["cases"][1]["representativeFacts"]["fieldCarCount"] = 7
    elif mutation == "competitors":
        for case in raw["cases"]:
            case["representativeFacts"]["similarLookingCompetitorCount"] = 0
    elif mutation == "challenges":
        for case in raw["cases"]:
            case["representativeFacts"]["identityChallenges"] = ["occlusion"]
    elif mutation == "case_ids":
        raw["cases"][1]["caseId"] = raw["cases"][0]["caseId"]
    elif mutation == "unknown_recording":
        raw["cases"][0]["recordingId"] = "missing-recording"
    else:
        raw["cases"][0]["windowEndMs"] = raw["recordings"][0]["durationMs"] + 1
    with pytest.raises(ValidationError, match=message):
        RepresentativeCorpusManifestV2.model_validate(raw)


@pytest.mark.parametrize(
    "field", ["corpus_id", "manifest_digest", "ground_truth_digest"]
)
def test_representative_evidence_must_match(field: str) -> None:
    manifest, truth, observations = corpus()
    changed = observations.model_copy(update={field: "0" * 64})
    with pytest.raises(ValueError, match="evidence differs"):
        evaluate_representative_benchmark(manifest, truth, changed)


def test_generation_digest_rejects_relabelled_provenance() -> None:
    manifest, truth, observations = corpus()
    relabelled = observations.model_copy(
        update={
            "provenance": observations.provenance.model_copy(
                update={"model": "relabelled-model"}
            )
        }
    )
    with pytest.raises(ValueError, match="evidence differs"):
        evaluate_representative_benchmark(manifest, truth, relabelled)


def test_candidate_provider_uses_same_corpus_evidence() -> None:
    manifest, truth, observations = corpus()
    candidate_provenance = observations.provenance.model_copy(
        update={"provider": "candidate-provider", "model": "candidate-model"}
    )
    candidate_cases = tuple(
        case.model_copy(
            update={
                "observations": tuple(
                    item.model_copy(
                        update={
                            "provenance": item.provenance.model_copy(
                                update={
                                    "provider": "candidate-provider",
                                    "model": "candidate-model",
                                }
                            )
                        }
                    )
                    for item in case.observations
                )
            }
        )
        for case in observations.cases
    )
    candidate = bind(
        manifest,
        truth,
        observations.model_copy(
            update={"provenance": candidate_provenance, "cases": candidate_cases}
        ),
    )

    report = evaluate_representative_benchmark(manifest, truth, candidate)

    assert report.passed
    assert report.provenance.provider == "candidate-provider"
    assert report.provenance.model == "candidate-model"
    assert report.evidence.manifest_digest == observations.manifest_digest
    assert report.evidence.ground_truth_digest == observations.ground_truth_digest


def test_candidate_cannot_weaken_corpus_evaluation_policy() -> None:
    manifest, truth, observations = corpus()
    weakened = observations.provenance.model_copy(
        update={"identity_match_iou_threshold": 0.000_001}
    )
    changed_cases = tuple(
        case.model_copy(
            update={
                "observations": tuple(
                    item.model_copy(
                        update={
                            "provenance": item.provenance.model_copy(
                                update={"identity_match_iou_threshold": 0.000_001}
                            )
                        }
                    )
                    for item in case.observations
                )
            }
        )
        for case in observations.cases
    )
    candidate = bind(
        manifest,
        truth,
        observations.model_copy(
            update={"provenance": weakened, "cases": changed_cases}
        ),
    )
    with pytest.raises(ValueError, match="evaluation policy differs"):
        evaluate_representative_benchmark(manifest, truth, candidate)


def test_representative_cross_document_evidence_is_validated() -> None:
    manifest, truth, observations = corpus()
    unknown_case = truth.cases[0].model_copy(update={"case_id": "unknown-case"})
    changed_truth = truth.model_copy(update={"cases": (unknown_case, *truth.cases[1:])})
    with pytest.raises(ValueError, match="same cases"):
        evaluate_representative_benchmark(
            manifest, changed_truth, bind(manifest, changed_truth, observations)
        )

    provenance = truth.cases[0].annotation_provenance.model_copy(
        update={"source_checksum_sha256": "0" * 64}
    )
    changed_case = truth.cases[0].model_copy(
        update={"annotation_provenance": provenance}
    )
    changed_truth = truth.model_copy(update={"cases": (changed_case, *truth.cases[1:])})
    with pytest.raises(ValueError, match="source checksum"):
        evaluate_representative_benchmark(
            manifest, changed_truth, bind(manifest, changed_truth, observations)
        )

    for index in (0, 1):
        spans = tuple(
            span.model_copy(update={"reason": "missing"})
            for span in truth.cases[index].ambiguous_spans
        )
        changed_case = truth.cases[index].model_copy(update={"ambiguous_spans": spans})
        cases = list(truth.cases)
        cases[index] = changed_case
        changed_truth = truth.model_copy(update={"cases": tuple(cases)})
        with pytest.raises(ValueError, match="challenge evidence"):
            evaluate_representative_benchmark(
                manifest, changed_truth, bind(manifest, changed_truth, observations)
            )

    changed_seed = manifest.cases[0].subject_seed.model_copy(
        update={"box": manifest.cases[0].subject_seed.box.model_copy(update={"x": 0.1})}
    )
    changed_manifest_case = manifest.cases[0].model_copy(
        update={"subject_seed": changed_seed}
    )
    changed_manifest = manifest.model_copy(
        update={"cases": (changed_manifest_case, *manifest.cases[1:])}
    )
    with pytest.raises(ValueError, match="seed differs"):
        evaluate_representative_benchmark(
            changed_manifest,
            truth,
            bind(changed_manifest, truth, observations),
        )


def test_representative_report_fails_switches_and_missed_gaps() -> None:
    manifest, truth, observations = corpus()
    first = observations.cases[0]
    raw = first.observations[1].model_dump(by_alias=True, mode="json")
    center = raw["center"]
    raw["box"] = {
        "x": center["x"] - 0.0025,
        "y": center["y"] - 0.0025,
        "width": 0.005,
        "height": 0.005,
    }
    switched = SubjectObservation.model_validate(raw)
    switched_case = first.model_copy(
        update={
            "observations": (first.observations[0], switched, first.observations[2])
        }
    )
    switched_set = observations.model_copy(
        update={"cases": (switched_case, *observations.cases[1:])}
    )
    report = evaluate_representative_benchmark(
        manifest, truth, bind(manifest, truth, switched_set)
    )
    assert report.coverage.ratio == 1.0
    assert report.identity.unflagged_switches == 1
    assert not report.passed

    no_gaps = tuple(case.model_copy(update={"gaps": ()}) for case in observations.cases)
    report = evaluate_representative_benchmark(
        manifest,
        truth,
        bind(
            manifest,
            truth,
            observations.model_copy(update={"cases": no_gaps}),
        ),
    )
    assert report.gaps.missed == 4
    assert not report.passed


def test_representative_coverage_does_not_treat_ambiguity_as_reidentification() -> None:
    manifest, truth, observations = corpus()
    first = truth.cases[0]
    post_gap = GroundTruthPass(
        passId="post-gap",
        cornerId="lower-right",
        entryTimestampMs=40_000,
        exitTimestampMs=40_500,
    )
    changed_case = first.model_copy(update={"passes": (*first.passes, post_gap)})
    changed_truth = truth.model_copy(update={"cases": (changed_case, *truth.cases[1:])})
    report = evaluate_representative_benchmark(
        manifest,
        changed_truth,
        bind(manifest, changed_truth, observations),
    )
    assert report.coverage.ground_truth_passes == 4
    assert report.coverage.eligible_passes == 3
    assert report.coverage.ratio == 0.75
    assert not report.passed


def test_one_candidate_gap_cannot_satisfy_two_truth_gaps() -> None:
    manifest, truth, observations = corpus()
    first_truth = truth.cases[0]
    second_gap = first_truth.ambiguous_spans[0].model_copy(
        update={"start_timestamp_ms": 32_000, "end_timestamp_ms": 32_500}
    )
    changed_truth_case = first_truth.model_copy(
        update={"ambiguous_spans": (*first_truth.ambiguous_spans, second_gap)}
    )
    changed_truth = truth.model_copy(
        update={"cases": (changed_truth_case, *truth.cases[1:])}
    )
    first_candidate = observations.cases[0]
    overlong_gap = first_candidate.gaps[0].model_copy(
        update={"end_timestamp_ms": second_gap.end_timestamp_ms}
    )
    changed_candidate = first_candidate.model_copy(update={"gaps": (overlong_gap,)})
    changed_observations = bind(
        manifest,
        changed_truth,
        observations.model_copy(
            update={"cases": (changed_candidate, *observations.cases[1:])}
        ),
    )

    report = evaluate_representative_benchmark(
        manifest, changed_truth, changed_observations
    )

    assert report.gaps.missed == 1
    assert not report.passed


def test_gap_matching_skips_earlier_candidate_gap() -> None:
    _, truth, observations = corpus()
    expected = truth.cases[0].ambiguous_spans[0]
    earlier = expected.model_copy(
        update={"start_timestamp_ms": 29_000, "end_timestamp_ms": 29_500}
    )

    assert benchmark_module._gap_counts(
        (expected,), (earlier, observations.cases[0].gaps[0]), 0
    ) == (1, 0, 1)


def test_identity_matching_work_is_linear_in_observation_count() -> None:
    manifest, truth, observations = corpus()
    count = 2_000
    base_annotation = truth.cases[0].identity_annotations[0]
    base_observation = observations.cases[0].observations[0]
    annotations = tuple(
        base_annotation.model_copy(
            update={"timestamp_ms": 12_000 + index * 33, "frame_index": 360 + index}
        )
        for index in range(count)
    )
    candidate_observations = tuple(
        base_observation.model_copy(
            update={"timestamp_ms": 12_000 + index * 33, "frame_index": 360 + index}
        )
        for index in range(count)
    )
    truth_case = truth.cases[0].model_copy(
        update={"identity_annotations": annotations, "ambiguous_spans": ()}
    )
    candidate_case = observations.cases[0].model_copy(
        update={"observations": candidate_observations, "gaps": ()}
    )

    with patch.object(
        benchmark_module,
        "_identity_frame_match",
        wraps=benchmark_module._identity_frame_match,
    ) as matcher:
        switches = benchmark_module._unflagged_switches(
            truth_case,
            candidate_case,
            observations.provenance,
            manifest.recordings[0],
            manifest.frame_timestamp_tolerance_ms,
        )

    assert switches == 0
    assert matcher.call_count <= count * 3


def test_cli_rejects_mixed_benchmark_versions(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    output = tmp_path / "report.json"
    assert (
        main(
            [
                "--manifest",
                str(FIXTURE_ROOT / "manifest.json"),
                "--ground-truth",
                str(FIXTURE_ROOT.parent / "ground-truth.json"),
                "--observations",
                str(FIXTURE_ROOT / "reference-observations.json"),
                "--output",
                str(output),
            ]
        )
        == 2
    )
    assert not output.exists()
    assert capsys.readouterr().err == "invalid benchmark input: ValidationError\n"


def test_fixture_json_has_no_duplicate_keys() -> None:
    for path in FIXTURE_ROOT.glob("*.json"):
        json.loads(path.read_text(), object_pairs_hook=reject_duplicate_pairs)
