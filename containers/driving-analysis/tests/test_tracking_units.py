import gzip
import hashlib
import os
from collections.abc import Callable
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
from typing import Literal

import pytest

import driving_analysis_service.tracking as tracking_module
from driving_analysis_service.contracts import SubjectProvenance
from driving_analysis_service.errors import MediaValidationError
from driving_analysis_service.inference import (
    DisabledInferenceProvider,
    FakeInferenceProvider,
    InferenceFailureError,
    InferenceUnavailableError,
)
from driving_analysis_service.media import ProbeMetadata
from driving_analysis_service.processes import (
    ProcessOutputLimitError,
    ProcessResult,
    ProcessTimeoutError,
)
from driving_analysis_service.settings import InferenceSettings, ServiceSettings
from driving_analysis_service.tracking import (
    FRAME_MANIFEST_SUFFIX,
    PREPARED_MEDIA_SUFFIX,
    ArtifactConflictError,
    InvalidArtifactError,
    RaceWindowPreparationService,
    SubjectTrackingService,
)
from driving_analysis_service.tracking_contracts import (
    PreparedFrameManifest,
    PrepareStageAccepted,
    PrepareStageRequest,
    ProcessingErrorCode,
    ProcessingRejected,
    ProviderCandidate,
    RaceWindow,
    TrackStageRequest,
)
from tests.conftest import (
    CORRELATION_ID,
    STAGED_MEDIA_ID,
    stage_media,
)

PREPARED_MEDIA_ID = "bde7ec63-86b9-4c86-a5e8-dbcf4a61f820"
SEGMENT_ID = "edb9d9c2-1ca8-48c3-ae7d-69222aab25f2"
SHA = "4" * 64


def _inference_settings() -> InferenceSettings:
    return InferenceSettings(
        provider="fake",
        model="fixture",
        model_version="1",
        model_digest=SHA,
        confidence_calibration="fixture-linear-v1",
        identity_confidence_threshold=0.8,
    )


def _prepare_request(byte_count: int = 1) -> PrepareStageRequest:
    return PrepareStageRequest.model_validate(
        {
            "contractVersion": "subject-tracking.v1",
            "correlationId": CORRELATION_ID,
            "caseId": "fixture-race",
            "preparedMediaId": PREPARED_MEDIA_ID,
            "input": {
                "stagedMediaId": STAGED_MEDIA_ID,
                "expectedByteCount": byte_count,
            },
            "window": {"startTimestampMs": 100, "endTimestampMs": 400},
            "pipelineVersion": "subject-tracking.v1",
        }
    )


def _dummy_prepared() -> PrepareStageAccepted:
    return PrepareStageAccepted.model_validate(
        {
            "contractVersion": "subject-tracking.v1",
            "correlationId": CORRELATION_ID,
            "outcome": "accepted",
            "caseId": "fixture-race",
            "prepared": {
                "preparedMediaId": PREPARED_MEDIA_ID,
                "byteCount": 10,
                "checksumSha256": SHA,
                "frameManifestByteCount": 10,
                "frameManifestChecksumSha256": SHA,
                "sourceByteCount": 20,
                "sourceChecksumSha256": SHA,
                "window": {"startTimestampMs": 100, "endTimestampMs": 400},
                "trackView": {
                    "x": 0.0,
                    "y": 1 / 3,
                    "width": 1.0,
                    "height": 2 / 3,
                },
                "width": 160,
                "height": 60,
                "decodedFrameCount": 3,
                "averageFrameRate": {"numerator": 10, "denominator": 1},
                "ffmpegVersion": "4.4",
                "pipelineVersion": "subject-tracking.v1",
                "preparationConfigurationDigest": SHA,
            },
        }
    )


def _track_request(prepared: PrepareStageAccepted | None = None) -> TrackStageRequest:
    descriptor = prepared or _dummy_prepared()
    return TrackStageRequest.model_validate(
        {
            "contractVersion": "subject-tracking.v1",
            "correlationId": CORRELATION_ID,
            "caseId": "fixture-race",
            "observationSegmentId": SEGMENT_ID,
            "prepared": descriptor.prepared.model_dump(mode="json", by_alias=True),
            "subjectSeed": {
                "timestampMs": 100,
                "frameIndex": 1,
                "identity": "subject",
                "box": {"x": 0.1, "y": 0.2, "width": 0.2, "height": 0.2},
            },
        }
    )


def _real_prepared(
    settings: ServiceSettings,
    accepted_video: Path,
) -> tuple[ServiceSettings, PrepareStageAccepted]:
    configured = replace(settings, inference=_inference_settings())
    result = RaceWindowPreparationService(configured).prepare(
        _prepare_request(stage_media(configured, accepted_video))
    )
    assert isinstance(result, PrepareStageAccepted)
    return configured, result


def _metadata(duration_ms: int = 500) -> ProbeMetadata:
    return ProbeMetadata(
        duration_ms=duration_ms,
        width=160,
        height=90,
        video_stream_index=0,
        video_codec="h264",
        audio_codecs=(),
        container_formats=("mov",),
        average_frame_rate=Fraction(10),
        time_base=Fraction(1, 10_240),
        sample_aspect_ratio=Fraction(1),
        display_aspect_ratio=Fraction(16, 9),
        start_time_ms=0,
    )


def _raise(error: Exception) -> None:
    raise error


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ArtifactConflictError(), "ARTIFACT_CONFLICT"),
        (ProcessTimeoutError(), "PROCESS_TIMEOUT"),
        (
            MediaValidationError(
                code="STAGED_MEDIA_NOT_FOUND",
                stage="claim",
                safe_message="safe",
            ),
            "MEDIA_UNAVAILABLE",
        ),
        (
            MediaValidationError(
                code="STAGED_MEDIA_MISMATCH",
                stage="inspect",
                safe_message="safe",
            ),
            "MEDIA_UNAVAILABLE",
        ),
        (
            MediaValidationError(
                code="PROCESS_TIMEOUT",
                stage="probe",
                safe_message="safe",
            ),
            "PROCESS_TIMEOUT",
        ),
        (
            MediaValidationError(
                code="CORRUPT_MEDIA",
                stage="probe",
                safe_message="safe",
            ),
            "PREPARATION_FAILED",
        ),
        (ValueError(), "PREPARATION_FAILED"),
    ],
)
def test_preparation_service_maps_every_safe_error(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    code: ProcessingErrorCode,
) -> None:
    service = RaceWindowPreparationService(settings)
    monkeypatch.setattr(service, "_prepare", lambda _request: _raise(error))
    response = service.prepare(_prepare_request())
    assert isinstance(response, ProcessingRejected)
    assert response.error.code == code
    assert response.error.stage == "prepare" or code != "PROCESS_TIMEOUT"


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ArtifactConflictError(), "ARTIFACT_CONFLICT"),
        (InferenceUnavailableError(), "INFERENCE_UNAVAILABLE"),
        (InvalidArtifactError(), "MEDIA_UNAVAILABLE"),
        (ProcessTimeoutError(), "PROCESS_TIMEOUT"),
        (ProcessOutputLimitError(), "RESOURCE_LIMIT"),
        (InferenceFailureError(), "INFERENCE_FAILED"),
    ],
)
def test_tracking_service_maps_every_safe_error(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    code: ProcessingErrorCode,
) -> None:
    service = SubjectTrackingService(
        settings,
        FakeInferenceProvider(_provenance()),
    )
    monkeypatch.setattr(service, "_track", lambda _request: _raise(error))
    response = service.track(_track_request())
    assert isinstance(response, ProcessingRejected)
    assert response.error.code == code
    assert response.error.stage == "track" or code != "PROCESS_TIMEOUT"


def _provenance() -> SubjectProvenance:
    return SubjectProvenance(
        provider="fake",
        model="fixture",
        modelVersion="1",
        modelDigest=SHA,
        pipelineVersion="subject-tracking.v1",
        configurationDigest=SHA,
        identityConfidenceThreshold=0.8,
        confidenceCalibration="fixture-linear-v1",
    )


def test_preparation_removes_media_when_manifest_publication_conflicts(
    settings: ServiceSettings,
    accepted_video: Path,
) -> None:
    settings.prepare_roots()
    manifest_path = settings.artifact_root / (
        f"{PREPARED_MEDIA_ID}{FRAME_MANIFEST_SUFFIX}"
    )
    manifest_path.write_bytes(b"existing")
    response = RaceWindowPreparationService(settings).prepare(
        _prepare_request(stage_media(settings, accepted_video))
    )
    assert isinstance(response, ProcessingRejected)
    assert response.error.code == "ARTIFACT_CONFLICT"
    assert not (
        settings.artifact_root / f"{PREPARED_MEDIA_ID}{PREPARED_MEDIA_SUFFIX}"
    ).exists()
    assert manifest_path.read_bytes() == b"existing"


def test_tracking_rejects_unready_provider(settings: ServiceSettings) -> None:
    response = SubjectTrackingService(
        settings,
        DisabledInferenceProvider(),
    ).track(_track_request())
    assert isinstance(response, ProcessingRejected)
    assert response.error.code == "INFERENCE_UNAVAILABLE"


def test_tracking_rejects_frame_manifest_count_mismatch(
    settings: ServiceSettings,
    accepted_video: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured, prepared = _real_prepared(settings, accepted_video)
    monkeypatch.setattr(tracking_module, "_extract_frames", lambda *_args: ())
    response = SubjectTrackingService(
        configured,
        FakeInferenceProvider(_provenance()),
    ).track(_track_request(prepared))
    assert isinstance(response, ProcessingRejected)
    assert response.error.code == "MEDIA_UNAVAILABLE"


def test_tracking_rejects_oversized_observation_segment(
    settings: ServiceSettings,
    accepted_video: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured, prepared = _real_prepared(settings, accepted_video)
    monkeypatch.setattr(tracking_module, "MAX_OBSERVATION_SEGMENT_BYTES", 1)
    response = SubjectTrackingService(
        configured,
        FakeInferenceProvider(_provenance()),
    ).track(_track_request(prepared))
    assert isinstance(response, ProcessingRejected)
    assert response.error.code == "RESOURCE_LIMIT"


def test_observer_rejects_limit_and_untrusted_first_frame(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = _track_request()
    manifest = _dummy_manifest()
    frame_paths = (Path("one.jpg"), Path("two.jpg"), Path("three.jpg"))
    service = SubjectTrackingService(
        settings,
        FakeInferenceProvider(_provenance()),
    )
    monkeypatch.setattr(tracking_module, "MAX_SUBJECT_OBSERVATIONS", 0)
    with pytest.raises(ProcessOutputLimitError):
        service._observe(request, manifest, frame_paths, 0)

    class UntrustedProvider(FakeInferenceProvider):
        def infer(self, **_kwargs: object) -> ProviderCandidate:
            return ProviderCandidate(
                box=None,
                identityConfidence=0.0,
                visibility="uncertain",
            )

    monkeypatch.setattr(tracking_module, "MAX_SUBJECT_OBSERVATIONS", 100_000)
    with pytest.raises(InferenceFailureError):
        SubjectTrackingService(
            settings,
            UntrustedProvider(_provenance()),
        )._observe(request, manifest, frame_paths, 0)


def _dummy_manifest() -> PreparedFrameManifest:
    return PreparedFrameManifest.model_validate(
        {
            "contractVersion": "subject-tracking.v1",
            "preparedMediaId": PREPARED_MEDIA_ID,
            "sourceChecksumSha256": SHA,
            "sourceByteCount": 20,
            "window": {"startTimestampMs": 100, "endTimestampMs": 400},
            "trackView": {"x": 0.0, "y": 1 / 3, "width": 1.0, "height": 2 / 3},
            "mediaByteCount": 10,
            "mediaChecksumSha256": SHA,
            "width": 160,
            "height": 60,
            "averageFrameRate": {"numerator": 10, "denominator": 1},
            "ffmpegVersion": "4.4",
            "pipelineVersion": "subject-tracking.v1",
            "preparationConfigurationDigest": SHA,
            "frames": [
                {"preparedFrameIndex": 0, "frameIndex": 1, "timestampMs": 100},
                {"preparedFrameIndex": 1, "frameIndex": 2, "timestampMs": 200},
                {"preparedFrameIndex": 2, "frameIndex": 3, "timestampMs": 300},
            ],
        }
    )


def test_race_window_and_ffmpeg_helpers_reject_invalid_output(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ValueError, match="recording duration"):
        tracking_module._validate_window(
            RaceWindow(startTimestampMs=100, endTimestampMs=600),
            _metadata(),
        )

    monkeypatch.setattr(
        tracking_module,
        "run_bounded_process",
        lambda *_args, **_kwargs: ProcessResult(1, b"", b"", 0),
    )
    with pytest.raises(ValueError, match="preparation failed"):
        tracking_module._prepare_track_view(
            tmp_path / "source.mp4",
            tmp_path / "output.mp4",
            RaceWindow(startTimestampMs=100, endTimestampMs=400),
            _metadata(),
            settings,
        )


@pytest.mark.parametrize(
    "case",
    [
        (ProcessResult(1, b"", b"", 0), 100, "unavailable"),
        (ProcessResult(0, b"\xff", b"", 0), 100, "invalid"),
        (ProcessResult(0, b"NaN\n", b"", 0), 100, "invalid"),
        (ProcessResult(0, b"", b"", 0), 100, "frame count"),
        (ProcessResult(0, b"0.0\n0.1\n", b"", 0), 1, "frame count"),
    ],
)
def test_prepared_frame_metadata_rejects_bad_probe_output(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    case: tuple[ProcessResult, int, str],
) -> None:
    result, max_frames, message = case
    limited = replace(settings, limits=replace(settings.limits, max_frames=max_frames))
    monkeypatch.setattr(
        tracking_module,
        "run_bounded_process",
        lambda *_args, **_kwargs: result,
    )
    with pytest.raises(ValueError, match=message):
        tracking_module._prepared_frames(
            tmp_path / "prepared.mp4",
            RaceWindow(startTimestampMs=100, endTimestampMs=400),
            Fraction(10),
            limited,
        )


@pytest.mark.parametrize("return_code", [0, 1])
def test_frame_extraction_rejects_failed_or_empty_output(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    return_code: int,
) -> None:
    output = tmp_path / "frames"
    output.mkdir()
    monkeypatch.setattr(
        tracking_module,
        "run_bounded_process",
        lambda *_args, **_kwargs: ProcessResult(return_code, b"", b"", 0),
    )
    with pytest.raises(InferenceFailureError):
        tracking_module._extract_frames(tmp_path / "prepared.mp4", output, settings)


def test_frame_extraction_rejects_too_many_frames(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = tmp_path / "frames"
    output.mkdir()
    (output / "00000000.jpg").write_bytes(b"x")
    (output / "00000001.jpg").write_bytes(b"x")
    limited = replace(settings, limits=replace(settings.limits, max_frames=1))
    monkeypatch.setattr(
        tracking_module,
        "run_bounded_process",
        lambda *_args, **_kwargs: ProcessResult(0, b"", b"", 0),
    )
    with pytest.raises(InferenceFailureError):
        tracking_module._extract_frames(tmp_path / "prepared.mp4", output, limited)


@pytest.mark.parametrize(
    "raw_factory",
    [lambda: b"not-gzip", lambda: gzip.compress(b"not-json", mtime=0)],
)
def test_frame_manifest_rejects_corrupt_content(
    settings: ServiceSettings,
    raw_factory: Callable[[], bytes],
) -> None:
    settings.prepare_roots()
    raw = raw_factory()
    request = _request_with_manifest_bytes(raw)
    path = settings.artifact_root / f"{PREPARED_MEDIA_ID}{FRAME_MANIFEST_SUFFIX}"
    path.write_bytes(raw)
    with pytest.raises(InvalidArtifactError):
        tracking_module._load_frame_manifest(request, settings)


def _request_with_manifest_bytes(raw: bytes) -> TrackStageRequest:
    request = _track_request()
    prepared = request.prepared.model_copy(
        update={
            "frame_manifest_byte_count": len(raw),
            "frame_manifest_checksum_sha256": hashlib.sha256(raw).hexdigest(),
        }
    )
    return request.model_copy(update={"prepared": prepared})


def test_frame_manifest_rejects_decompression_limit_and_descriptor_mismatch(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings.prepare_roots()
    raw = gzip.compress(b"1234567890", mtime=0)
    request = _request_with_manifest_bytes(raw)
    path = settings.artifact_root / f"{PREPARED_MEDIA_ID}{FRAME_MANIFEST_SUFFIX}"
    path.write_bytes(raw)
    monkeypatch.setattr(tracking_module, "MAX_MANIFEST_BYTES", 5)
    with pytest.raises(InvalidArtifactError):
        tracking_module._load_frame_manifest(request, settings)

    monkeypatch.setattr(tracking_module, "MAX_MANIFEST_BYTES", 64 * 1024 * 1024)
    manifest_raw = gzip.compress(
        tracking_module._canonical_json(
            _dummy_manifest().model_dump(mode="json", by_alias=True)
        ),
        mtime=0,
    )
    mismatch = _request_with_manifest_bytes(manifest_raw)
    mismatch = mismatch.model_copy(
        update={"prepared": mismatch.prepared.model_copy(update={"width": 999})}
    )
    path.write_bytes(manifest_raw)
    with pytest.raises(InvalidArtifactError):
        tracking_module._load_frame_manifest(mismatch, settings)


def test_seed_lookup_can_skip_frames_and_reject_missing_seed() -> None:
    manifest = _dummy_manifest()
    request = _track_request()
    second_seed = request.subject_seed.model_copy(
        update={"frame_index": 2, "timestamp_ms": 200}
    )
    assert (
        tracking_module._seed_position(
            request.model_copy(update={"subject_seed": second_seed}),
            manifest,
        )
        == 1
    )
    missing_seed = request.subject_seed.model_copy(update={"frame_index": 99})
    with pytest.raises(InvalidArtifactError):
        tracking_module._seed_position(
            request.model_copy(update={"subject_seed": missing_seed}),
            manifest,
        )


@pytest.mark.parametrize(
    ("result", "message"),
    [
        (ProcessResult(1, b"", b"", 0), "unavailable"),
        (ProcessResult(0, b"", b"", 0), "invalid"),
        (ProcessResult(0, b"\xff", b"", 0), "invalid"),
        (ProcessResult(0, b"wrong version 1\n", b"", 0), "invalid"),
    ],
)
def test_ffmpeg_version_rejects_invalid_process_output(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
    result: ProcessResult,
    message: str,
) -> None:
    monkeypatch.setattr(
        tracking_module,
        "run_bounded_process",
        lambda *_args, **_kwargs: result,
    )
    with pytest.raises(ValueError, match=message):
        tracking_module._ffmpeg_version(settings)


def test_publish_cleanup_and_artifact_verification_defenses(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings.prepare_roots()
    destination = settings.artifact_root / "artifact"

    def fail_write(_descriptor: int, _value: bytes) -> None:
        msg = "write failed"
        raise PermissionError(msg)

    monkeypatch.setattr(tracking_module, "_write_all", fail_write)
    with pytest.raises(PermissionError, match="write failed"):
        tracking_module._publish_bytes(b"value", destination)
    assert list(settings.artifact_root.iterdir()) == []
    monkeypatch.undo()

    missing = tracking_module._PublishedArtifact(destination, 0, SHA)
    tracking_module._remove_published(missing)
    destination.mkdir()
    tracking_module._remove_published(missing)
    assert destination.is_dir()

    source = tmp_path / "source"
    source.write_bytes(b"value")
    digest = hashlib.sha256(b"value").hexdigest()
    with pytest.raises(InvalidArtifactError):
        tracking_module._read_verified_artifact(
            source,
            expected_bytes=5,
            expected_checksum=digest,
            max_bytes=1,
        )
    with pytest.raises(InvalidArtifactError):
        tracking_module._read_verified_artifact(
            source,
            expected_bytes=4,
            expected_checksum=digest,
            max_bytes=10,
        )

    with pytest.raises(InvalidArtifactError):
        tracking_module._copy_verified_artifact(
            source,
            tmp_path / "copy-too-large",
            expected_bytes=5,
            expected_checksum=digest,
            max_bytes=1,
        )
    with pytest.raises(InvalidArtifactError):
        tracking_module._copy_verified_artifact(
            source,
            tmp_path / "copy-mismatch",
            expected_bytes=4,
            expected_checksum=digest,
            max_bytes=10,
        )

    with pytest.raises(InvalidArtifactError):
        tracking_module._open_artifact(tmp_path / "missing")
    with pytest.raises(InvalidArtifactError):
        tracking_module._open_artifact(destination)

    empty = tmp_path / "empty"
    empty.write_bytes(b"")
    with pytest.raises(ValueError, match="empty"):
        tracking_module._file_digest(empty, max_bytes=10)
    with pytest.raises(ValueError, match="byte limit"):
        tracking_module._file_digest(source, max_bytes=1)


def test_write_all_rejects_zero_byte_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(os, "write", lambda _descriptor, _value: 0)
    with pytest.raises(OSError, match="Unable to write artifact"):
        tracking_module._write_all(1, b"value")


@pytest.mark.parametrize(
    ("box", "confidence", "visibility", "trusted", "reason"),
    [
        (None, 1.0, "uncertain", False, "missing"),
        (None, 1.0, "occluded", False, "occluded"),
        (
            {"x": 0.1, "y": 0.2, "width": 0.2, "height": 0.2},
            0.9,
            "uncertain",
            False,
            "ambiguous-identity",
        ),
        (
            {"x": 0.1, "y": 0.2, "width": 0.2, "height": 0.2},
            0.7,
            "visible",
            False,
            "ambiguous-identity",
        ),
        (
            {"x": 0.1, "y": 0.2, "width": 0.2, "height": 0.2},
            0.8,
            "visible",
            True,
            "ambiguous-identity",
        ),
    ],
)
def test_trust_and_gap_classification(
    box: dict[str, float] | None,
    confidence: float,
    visibility: Literal["visible", "occluded", "uncertain"],
    *,
    trusted: bool,
    reason: str,
) -> None:
    candidate = ProviderCandidate.model_validate(
        {
            "box": box,
            "identityConfidence": confidence,
            "visibility": visibility,
        }
    )
    result = tracking_module._trusted_box(candidate, 0.8)
    assert (result is not None) is trusted
    assert tracking_module._gap_reason(candidate) == reason
