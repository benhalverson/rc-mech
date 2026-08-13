from pathlib import Path

import pytest
from pydantic import ValidationError

from driving_analysis_service.settings import InferenceSettings, ServiceSettings
from driving_analysis_service.tracking_contracts import (
    FixedTrackView,
    ObservationSegmentArtifact,
    PreparedFrameManifest,
    PrepareStageAccepted,
    PrepareStageRequest,
    ProcessingRejected,
    ProcessingSafeError,
    ProviderCandidate,
    RaceWindow,
    SubjectObservationSegment,
    TrackStageAccepted,
    TrackStageRequest,
)

UUID = "bde7ec63-86b9-4c86-a5e8-dbcf4a61f820"
SHA = "4" * 64


def _manifest_payload() -> dict[str, object]:
    return {
        "contractVersion": "subject-tracking.v1",
        "preparedMediaId": UUID,
        "caseId": "fixture-race",
        "sourceChecksumSha256": SHA,
        "sourceByteCount": 100,
        "window": {"startTimestampMs": 100, "endTimestampMs": 400},
        "trackView": {"x": 0.0, "y": 1 / 3, "width": 1.0, "height": 2 / 3},
        "mediaByteCount": 50,
        "mediaChecksumSha256": SHA,
        "width": 160,
        "height": 60,
        "averageFrameRate": {"numerator": 10, "denominator": 1},
        "ffmpegVersion": "4.4",
        "pipelineVersion": "subject-tracking.v1",
        "preparationInputDigest": SHA,
        "preparationConfigurationDigest": SHA,
        "frames": [
            {"preparedFrameIndex": 0, "frameIndex": 1, "timestampMs": 100},
            {"preparedFrameIndex": 1, "frameIndex": 2, "timestampMs": 200},
        ],
    }


def _prepared_payload() -> dict[str, object]:
    manifest = _manifest_payload()
    return {
        "preparedMediaId": UUID,
        "caseId": "fixture-race",
        "byteCount": manifest["mediaByteCount"],
        "checksumSha256": SHA,
        "frameManifestByteCount": 40,
        "frameManifestChecksumSha256": SHA,
        "sourceByteCount": manifest["sourceByteCount"],
        "sourceChecksumSha256": SHA,
        "window": manifest["window"],
        "trackView": manifest["trackView"],
        "width": manifest["width"],
        "height": manifest["height"],
        "decodedFrameCount": 2,
        "averageFrameRate": manifest["averageFrameRate"],
        "ffmpegVersion": manifest["ffmpegVersion"],
        "pipelineVersion": manifest["pipelineVersion"],
        "preparationInputDigest": SHA,
        "preparationConfigurationDigest": SHA,
    }


def _provenance() -> dict[str, object]:
    return {
        "provider": "fake",
        "model": "fixture",
        "modelVersion": "1",
        "modelDigest": SHA,
        "pipelineVersion": "subject-tracking.v1",
        "configurationDigest": SHA,
        "identityConfidenceThreshold": 0.8,
        "confidenceCalibration": "fixture-linear-v1",
    }


def _segment_payload(*, completed: bool, gap: object) -> dict[str, object]:
    return {
        "observationSegmentId": UUID,
        "caseId": "fixture-race",
        "byteCount": 20,
        "checksumSha256": SHA,
        "contentEncoding": "gzip",
        "mediaType": "application/vnd.rc-mech.subject-observations+json",
        "observationCount": 1,
        "completed": completed,
        "gap": gap,
        "provenance": _provenance(),
        "ffmpegVersion": "4.4",
        "sourceChecksumSha256": SHA,
        "preparedChecksumSha256": SHA,
        "preparationConfigurationDigest": SHA,
        "trackingInputDigest": SHA,
    }


def test_race_window_and_fixed_track_view_reject_alternatives() -> None:
    with pytest.raises(ValidationError, match="positive duration"):
        RaceWindow(startTimestampMs=100, endTimestampMs=100)
    with pytest.raises(ValidationError, match="fixed bottom two-thirds"):
        FixedTrackView(x=0.0, y=0.0, width=1.0, height=1.0)


def test_prepare_request_rejects_a_caller_claimed_pipeline_version() -> None:
    with pytest.raises(ValidationError, match=r"subject-tracking\.v1"):
        PrepareStageRequest.model_validate(
            {
                "contractVersion": "subject-tracking.v1",
                "correlationId": UUID,
                "caseId": "fixture-race",
                "preparedMediaId": UUID,
                "input": {"stagedMediaId": UUID, "expectedByteCount": 100},
                "window": {"startTimestampMs": 100, "endTimestampMs": 400},
                "pipelineVersion": "caller-claimed-version",
            }
        )


@pytest.mark.parametrize(
    "frames",
    [
        [
            {"preparedFrameIndex": 0, "frameIndex": 1, "timestampMs": 100},
            {"preparedFrameIndex": 2, "frameIndex": 2, "timestampMs": 200},
        ],
        [
            {"preparedFrameIndex": 0, "frameIndex": 1, "timestampMs": 100},
            {"preparedFrameIndex": 1, "frameIndex": 1, "timestampMs": 200},
        ],
        [
            {"preparedFrameIndex": 0, "frameIndex": 1, "timestampMs": 100},
            {"preparedFrameIndex": 1, "frameIndex": 2, "timestampMs": 100},
        ],
    ],
)
def test_prepared_manifest_requires_strict_order(
    frames: list[dict[str, int]],
) -> None:
    payload = _manifest_payload()
    payload["frames"] = frames
    with pytest.raises(ValidationError, match="strictly ordered"):
        PreparedFrameManifest.model_validate(payload)


def test_prepared_manifest_requires_zero_start_and_window_bounds() -> None:
    payload = _manifest_payload()
    payload["frames"] = [{"preparedFrameIndex": 1, "frameIndex": 1, "timestampMs": 100}]
    with pytest.raises(ValidationError, match="start at zero"):
        PreparedFrameManifest.model_validate(payload)

    payload["frames"] = [{"preparedFrameIndex": 0, "frameIndex": 0, "timestampMs": 99}]
    with pytest.raises(ValidationError, match="inside the Race window"):
        PreparedFrameManifest.model_validate(payload)


def test_processing_errors_are_canonical_for_prepare_and_track_timeouts() -> None:
    assert (
        ProcessingSafeError(
            code="PROCESS_TIMEOUT",
            stage="prepare",
            message="processing exceeded its time limit",
        ).stage
        == "prepare"
    )
    assert (
        ProcessingSafeError(
            code="PROCESS_TIMEOUT",
            stage="track",
            message="processing exceeded its time limit",
        ).stage
        == "track"
    )
    with pytest.raises(ValidationError, match="timeout error fields"):
        ProcessingSafeError(
            code="PROCESS_TIMEOUT",
            stage="initialize",
            message="processing exceeded its time limit",
        )
    with pytest.raises(ValidationError, match="error fields"):
        ProcessingSafeError(
            code="INFERENCE_FAILED",
            stage="initialize",
            message="inference failed safely",
        )


def test_track_seed_must_be_inside_window() -> None:
    with pytest.raises(ValidationError, match="seed must be inside"):
        TrackStageRequest.model_validate(
            {
                "contractVersion": "subject-tracking.v1",
                "correlationId": "c3d1ea64-7c62-4a1e-a41f-43fe101b7f41",
                "caseId": "fixture-race",
                "observationSegmentId": UUID,
                "prepared": _prepared_payload(),
                "subjectSeed": {
                    "timestampMs": 400,
                    "frameIndex": 4,
                    "identity": "subject",
                    "box": {"x": 0.1, "y": 0.2, "width": 0.2, "height": 0.2},
                },
            }
        )

    mismatched_case = {
        "contractVersion": "subject-tracking.v1",
        "correlationId": "c3d1ea64-7c62-4a1e-a41f-43fe101b7f41",
        "caseId": "different-case",
        "observationSegmentId": UUID,
        "prepared": _prepared_payload(),
        "subjectSeed": {
            "timestampMs": 100,
            "frameIndex": 1,
            "identity": "subject",
            "box": {"x": 0.1, "y": 0.2, "width": 0.2, "height": 0.2},
        },
    }
    with pytest.raises(ValidationError, match="Tracking case"):
        TrackStageRequest.model_validate(mismatched_case)


@pytest.mark.parametrize(
    ("completed", "gap"),
    [
        (
            True,
            {
                "startTimestampMs": 200,
                "reason": "ambiguous-identity",
            },
        ),
        (False, None),
    ],
)
def test_observation_segment_completion_matches_gap(
    *,
    completed: bool,
    gap: object,
) -> None:
    with pytest.raises(ValidationError, match="completed segments"):
        ObservationSegmentArtifact.model_validate(
            _segment_payload(completed=completed, gap=gap)
        )


def test_visible_provider_candidate_requires_a_box() -> None:
    with pytest.raises(ValidationError, match="require a box"):
        ProviderCandidate(box=None, identityConfidence=1.0, visibility="visible")


def test_observation_segment_rejects_observations_inside_open_gap() -> None:
    with pytest.raises(ValidationError, match="must precede"):
        SubjectObservationSegment.model_validate(
            {
                "contractVersion": "subject-observation-segment.v1",
                "outcome": "accepted",
                "caseId": "fixture-race",
                "observations": [
                    {
                        "timestampMs": 200,
                        "frameIndex": 2,
                        "box": {"x": 0.1, "y": 0.2, "width": 0.2, "height": 0.2},
                        "center": {"x": 0.2, "y": 0.3},
                        "identityConfidence": 0.9,
                        "visibility": "visible",
                        "origin": "detected",
                        "provenance": _provenance(),
                    }
                ],
                "openGap": {
                    "startTimestampMs": 200,
                    "reason": "ambiguous-identity",
                },
                "provenance": _provenance(),
            }
        )


def test_inference_settings_validate_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("INFERENCE_PROVIDER", "local-http")
    monkeypatch.setenv("INFERENCE_MODEL", "llava:13b")
    monkeypatch.setenv("INFERENCE_MODEL_VERSION", "sha")
    monkeypatch.setenv("INFERENCE_MODEL_DIGEST", SHA)
    monkeypatch.setenv("INFERENCE_CONFIDENCE_CALIBRATION", "ollama-manual-v1")
    monkeypatch.setenv("INFERENCE_IDENTITY_CONFIDENCE_THRESHOLD", "0.75")
    monkeypatch.setenv("INFERENCE_PROVIDER_URL", "http://localhost:11434")
    monkeypatch.setenv("INFERENCE_FIXTURE_PATH", str(tmp_path / "fixture.json"))
    monkeypatch.setenv("INFERENCE_REQUEST_TIMEOUT_SECONDS", "12")
    settings = InferenceSettings.from_environment()
    assert settings.provider == "local-http"
    assert settings.model == "llava:13b"
    assert settings.model_version == "sha"
    assert settings.model_digest == SHA
    assert settings.confidence_calibration == "ollama-manual-v1"
    assert settings.identity_confidence_threshold == 0.75
    assert settings.endpoint == "http://localhost:11434"
    assert settings.fixture_path == tmp_path / "fixture.json"
    assert settings.request_timeout_seconds == 12

    monkeypatch.setenv("RC_MECH_MEDIA_STAGING_ROOT", str(tmp_path / "staged"))
    monkeypatch.setenv("RC_MECH_MEDIA_WORK_ROOT", str(tmp_path / "work"))
    monkeypatch.setenv("RC_MECH_ANALYSIS_ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    service = ServiceSettings.from_environment()
    assert service.artifact_root == tmp_path / "artifacts"
    assert service.inference.model == "llava:13b"


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        ("INFERENCE_PROVIDER", "remote", "INFERENCE_PROVIDER"),
        (
            "INFERENCE_IDENTITY_CONFIDENCE_THRESHOLD",
            "2",
            "threshold",
        ),
        ("INFERENCE_REQUEST_TIMEOUT_SECONDS", "0", "timeout"),
    ],
)
def test_inference_settings_reject_invalid_environment(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: str,
    message: str,
) -> None:
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=message):
        InferenceSettings.from_environment()


@pytest.mark.parametrize(
    ("filename", "contract"),
    [
        ("prepare-accepted.json", PrepareStageAccepted),
        ("track-gap-accepted.json", TrackStageAccepted),
        ("track-rejected.json", ProcessingRejected),
    ],
)
def test_versioned_processing_response_fixtures_are_strict(
    filename: str,
    contract: type[PrepareStageAccepted | TrackStageAccepted | ProcessingRejected],
) -> None:
    fixture = Path(__file__).parent / "fixtures" / "subject-tracking" / filename
    parsed = contract.model_validate_json(fixture.read_bytes())
    assert parsed.contract_version == "subject-tracking.v1"
