import gzip
import hashlib
import os
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
from typing import Literal

import pytest

import driving_analysis_service.preparation as preparation_module
import driving_analysis_service.tracking as tracking_module
import driving_analysis_service.tracking_artifacts as artifact_module
from driving_analysis_service.contracts import SubjectProvenance
from driving_analysis_service.errors import MediaValidationError
from driving_analysis_service.inference import (
    DisabledInferenceProvider,
    FakeInferenceProvider,
    InferenceFailureError,
    InferenceUnavailableError,
)
from driving_analysis_service.media import ProbeMetadata
from driving_analysis_service.preparation import RaceWindowPreparationService
from driving_analysis_service.processes import (
    ProcessOutputLimitError,
    ProcessResult,
    ProcessTimeoutError,
)
from driving_analysis_service.processing_deadline import remaining_seconds
from driving_analysis_service.processing_errors import InvalidProcessingRequestError
from driving_analysis_service.settings import InferenceSettings, ServiceSettings
from driving_analysis_service.tracking import SubjectTrackingService
from driving_analysis_service.tracking_artifacts import (
    FRAME_MANIFEST_SUFFIX,
    PREPARED_BUNDLE_SUFFIX,
    PREPARED_MEDIA_SUFFIX,
    ArtifactConflictError,
    InvalidArtifactError,
)
from driving_analysis_service.tracking_contracts import (
    PreparedFrameManifest,
    PrepareStageAccepted,
    PrepareStageRequest,
    ProcessingErrorCode,
    ProcessingRejected,
    ProviderCandidate,
    RaceWindow,
    TrackStageAccepted,
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
                "caseId": "fixture-race",
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
                "preparationInputDigest": SHA,
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
        (ProcessOutputLimitError(), "RESOURCE_LIMIT"),
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
    monkeypatch.setattr(service, "_prepare", lambda _request, _deadline: _raise(error))
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
    monkeypatch.setattr(service, "_track", lambda _request, _deadline: _raise(error))
    response = service.track(_track_request())
    assert isinstance(response, ProcessingRejected)
    assert response.error.code == code
    assert response.error.stage == "track" or code != "PROCESS_TIMEOUT"


def test_processing_stages_reject_work_when_admission_is_full(
    settings: ServiceSettings,
) -> None:
    admission = threading.BoundedSemaphore(1)
    assert admission.acquire(blocking=False)
    try:
        prepared = RaceWindowPreparationService(settings, admission).prepare(
            _prepare_request()
        )
        tracked = SubjectTrackingService(
            settings,
            FakeInferenceProvider(_provenance()),
            admission,
        ).track(_track_request())
    finally:
        admission.release()
    assert isinstance(prepared, ProcessingRejected)
    assert prepared.error.code == "SERVICE_BUSY"
    assert prepared.error.stage == "admission"
    assert isinstance(tracked, ProcessingRejected)
    assert tracked.error.code == "SERVICE_BUSY"
    assert tracked.error.stage == "admission"


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
    bundle = settings.artifact_root / f"{PREPARED_MEDIA_ID}{PREPARED_BUNDLE_SUFFIX}"
    bundle.mkdir()
    manifest_path = bundle / f"{PREPARED_MEDIA_ID}{FRAME_MANIFEST_SUFFIX}"
    manifest_path.write_bytes(b"existing")
    response = RaceWindowPreparationService(settings).prepare(
        _prepare_request(stage_media(settings, accepted_video))
    )
    assert isinstance(response, ProcessingRejected)
    assert response.error.code == "ARTIFACT_CONFLICT"
    assert not (bundle / f"{PREPARED_MEDIA_ID}{PREPARED_MEDIA_SUFFIX}").exists()
    assert manifest_path.read_bytes() == b"existing"


def test_preparation_rejects_frame_loss_and_an_oversized_window(
    settings: ServiceSettings,
    accepted_video: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(preparation_module, "_prepared_frame_count", lambda *_args: 0)
    mismatch = RaceWindowPreparationService(settings).prepare(
        _prepare_request(stage_media(settings, accepted_video))
    )
    assert isinstance(mismatch, ProcessingRejected)
    assert mismatch.error.code == "PREPARATION_FAILED"

    limited = replace(
        settings,
        limits=replace(settings.limits, max_race_window_ms=1),
    )
    with pytest.raises(InvalidProcessingRequestError):
        preparation_module._validate_window(
            RaceWindow(startTimestampMs=100, endTimestampMs=400),
            _metadata(),
            limited,
        )


def test_completed_preparation_rejects_changed_input_and_tampering(
    settings: ServiceSettings,
    accepted_video: Path,
) -> None:
    configured, prepared = _real_prepared(settings, accepted_video)
    changed = RaceWindowPreparationService(configured).prepare(
        _prepare_request(prepared.prepared.source_byte_count + 1)
    )
    assert isinstance(changed, ProcessingRejected)
    assert changed.error.code == "ARTIFACT_CONFLICT"

    changed_staged_input = _prepare_request(
        prepared.prepared.source_byte_count
    ).model_copy(
        update={
            "input": _prepare_request(
                prepared.prepared.source_byte_count
            ).input.model_copy(
                update={"staged_media_id": "00d6dc08-7f28-4d85-9c3d-994614a982c4"}
            )
        }
    )
    changed_identity = RaceWindowPreparationService(configured).prepare(
        changed_staged_input
    )
    assert isinstance(changed_identity, ProcessingRejected)
    assert changed_identity.error.code == "ARTIFACT_CONFLICT"

    media_path = artifact_module.bundle_member_path(
        configured,
        PREPARED_MEDIA_ID,
        PREPARED_BUNDLE_SUFFIX,
        PREPARED_MEDIA_SUFFIX,
    )
    media_path.write_bytes(b"tampered")
    tampered = RaceWindowPreparationService(configured).prepare(
        _prepare_request(prepared.prepared.source_byte_count)
    )
    assert isinstance(tampered, ProcessingRejected)
    assert tampered.error.code == "PREPARATION_FAILED"


def test_preparation_recovers_a_concurrent_identical_publication(
    settings: ServiceSettings,
    accepted_video: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured, prepared = _real_prepared(settings, accepted_video)
    original_recover = preparation_module._recover_completed_preparation
    calls = 0

    def recover(
        request: PrepareStageRequest,
        current_settings: ServiceSettings,
        deadline: float,
    ) -> object:
        nonlocal calls
        calls += 1
        if calls == 1:
            return None
        return original_recover(request, current_settings, deadline)

    monkeypatch.setattr(preparation_module, "_recover_completed_preparation", recover)
    stage_media(configured, accepted_video)
    duplicate = RaceWindowPreparationService(configured).prepare(
        _prepare_request(prepared.prepared.source_byte_count)
    )
    assert isinstance(duplicate, PrepareStageAccepted)
    assert duplicate.prepared == prepared.prepared


def test_tracking_recovers_a_concurrent_identical_publication(
    settings: ServiceSettings,
    accepted_video: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured, prepared = _real_prepared(settings, accepted_video)
    provider = FakeInferenceProvider(_provenance())
    request = _track_request(prepared)
    first = SubjectTrackingService(configured, provider).track(request)
    assert isinstance(first, TrackStageAccepted)
    original_recover = tracking_module._recover_completed_segment
    calls = 0

    def recover(
        current_request: TrackStageRequest,
        current_settings: ServiceSettings,
        tracking_input_digest: str,
        deadline: float,
    ) -> object:
        nonlocal calls
        calls += 1
        if calls == 1:
            return None
        return original_recover(
            current_request,
            current_settings,
            tracking_input_digest,
            deadline,
        )

    monkeypatch.setattr(tracking_module, "_recover_completed_segment", recover)
    duplicate = SubjectTrackingService(configured, provider).track(request)
    assert isinstance(duplicate, TrackStageAccepted)
    assert duplicate.segment == first.segment

    class OfflineProvider(FakeInferenceProvider):
        def ready(self, *, timeout_seconds: float | None = None) -> bool:
            del timeout_seconds
            return False

    offline_retry = SubjectTrackingService(
        configured,
        OfflineProvider(_provenance()),
    ).track(request)
    assert isinstance(offline_retry, TrackStageAccepted)
    assert offline_retry.segment == first.segment
    new_offline_request = request.model_copy(
        update={"observation_segment_id": "4979546f-4377-48de-b904-17fcf96da347"}
    )
    unavailable = SubjectTrackingService(
        configured,
        OfflineProvider(_provenance()),
    ).track(new_offline_request)
    assert isinstance(unavailable, ProcessingRejected)
    assert unavailable.error.code == "INFERENCE_UNAVAILABLE"

    changed_seed = request.model_copy(
        update={
            "subject_seed": request.subject_seed.model_copy(
                update={"identity": "different-subject"}
            )
        }
    )
    seed_conflict = SubjectTrackingService(configured, provider).track(changed_seed)
    assert isinstance(seed_conflict, ProcessingRejected)
    assert seed_conflict.error.code == "ARTIFACT_CONFLICT"

    changed_provenance = _provenance().model_copy(
        update={"identity_confidence_threshold": 0.9}
    )
    provider_conflict = SubjectTrackingService(
        configured,
        FakeInferenceProvider(changed_provenance),
    ).track(request)
    assert isinstance(provider_conflict, ProcessingRejected)
    assert provider_conflict.error.code == "ARTIFACT_CONFLICT"

    conflict_calls = 0

    def recover_conflict(
        _current_request: TrackStageRequest,
        _current_settings: ServiceSettings,
        _tracking_input_digest: str,
        _deadline: float,
    ) -> object:
        nonlocal conflict_calls
        conflict_calls += 1
        if conflict_calls == 1:
            return None
        return first.segment.model_copy(update={"checksum_sha256": "0" * 64})

    monkeypatch.setattr(
        tracking_module,
        "_recover_completed_segment",
        recover_conflict,
    )
    conflict = SubjectTrackingService(configured, provider).track(request)
    assert isinstance(conflict, ProcessingRejected)
    assert conflict.error.code == "ARTIFACT_CONFLICT"


def test_incomplete_tracking_bundle_has_no_completed_segment(
    settings: ServiceSettings,
) -> None:
    settings.prepare_roots()
    artifact_module.bundle_path(
        settings,
        SEGMENT_ID,
        artifact_module.OBSERVATION_BUNDLE_SUFFIX,
    ).mkdir()
    assert (
        tracking_module._recover_completed_segment(
            _track_request(),
            settings,
            SHA,
            time.monotonic() + 10,
        )
        is None
    )


def test_tracking_rejects_unready_provider(settings: ServiceSettings) -> None:
    response = SubjectTrackingService(
        settings,
        DisabledInferenceProvider(),
    ).track(_track_request())
    assert isinstance(response, ProcessingRejected)
    assert response.error.code == "INFERENCE_UNAVAILABLE"


def test_tracking_deadline_includes_provider_readiness(
    settings: ServiceSettings,
) -> None:
    class SlowReadyProvider(FakeInferenceProvider):
        def ready(self, *, timeout_seconds: float | None = None) -> bool:
            assert timeout_seconds is not None
            time.sleep(0.01)
            return True

    limited = replace(
        settings,
        limits=replace(settings.limits, process_timeout_seconds=0.001),
    )
    response = SubjectTrackingService(
        limited,
        SlowReadyProvider(_provenance()),
    ).track(_track_request())
    assert isinstance(response, ProcessingRejected)
    assert response.error.code == "PROCESS_TIMEOUT"
    assert response.error.stage == "track"


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


def test_tracking_rejects_oversized_window_and_provider_digest_drift(
    settings: ServiceSettings,
    accepted_video: Path,
) -> None:
    configured, prepared = _real_prepared(settings, accepted_video)
    limited = replace(
        configured,
        limits=replace(configured.limits, max_race_window_ms=1),
    )
    oversized = SubjectTrackingService(
        limited,
        FakeInferenceProvider(_provenance()),
    ).track(_track_request(prepared))
    assert isinstance(oversized, ProcessingRejected)
    assert oversized.error.code == "INVALID_REQUEST"
    assert oversized.error.stage == "request"

    checks: list[bool] = []

    class DriftingProvider(FakeInferenceProvider):
        def ready(self, *, timeout_seconds: float | None = None) -> bool:
            del timeout_seconds
            checks.append(True)
            return len(checks) == 1

    drifted = SubjectTrackingService(
        configured,
        DriftingProvider(_provenance()),
    ).track(_track_request(prepared))
    assert isinstance(drifted, ProcessingRejected)
    assert drifted.error.code == "INFERENCE_UNAVAILABLE"


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
        service._observe(request, manifest, frame_paths, 0, time.monotonic() + 10)

    class UntrustedProvider(FakeInferenceProvider):
        def infer(self, **_kwargs: object) -> ProviderCandidate:
            return ProviderCandidate(
                box=None,
                identityConfidence=0.0,
                visibility="uncertain",
            )

    monkeypatch.setattr(tracking_module, "MAX_SUBJECT_OBSERVATIONS", 100_000)
    observations, gap = SubjectTrackingService(
        settings,
        UntrustedProvider(_provenance()),
    )._observe(request, manifest, frame_paths, 0, time.monotonic() + 10)
    assert observations == ()
    assert gap is not None
    assert gap.start_timestamp_ms == 100


def _dummy_manifest() -> PreparedFrameManifest:
    return PreparedFrameManifest.model_validate(
        {
            "contractVersion": "subject-tracking.v1",
            "preparedMediaId": PREPARED_MEDIA_ID,
            "caseId": "fixture-race",
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
            "preparationInputDigest": SHA,
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
        preparation_module._validate_window(
            RaceWindow(startTimestampMs=100, endTimestampMs=600),
            _metadata(),
            settings,
        )

    monkeypatch.setattr(
        preparation_module,
        "run_bounded_process",
        lambda *_args, **_kwargs: ProcessResult(1, b"", b"", 0),
    )
    with pytest.raises(ValueError, match="preparation failed"):
        preparation_module._prepare_track_view(
            tmp_path / "source.mp4",
            tmp_path / "output.mp4",
            RaceWindow(startTimestampMs=100, endTimestampMs=400),
            _metadata(),
            settings,
            time.monotonic() + 10,
        )


@pytest.mark.parametrize(
    "case",
    [
        (ProcessResult(1, b"", b"", 0), 100, "unavailable"),
        (ProcessResult(0, b"\xff", b"", 0), 100, "invalid"),
        (ProcessResult(0, b"NaN\n", b"", 0), 100, "invalid"),
        (ProcessResult(0, b"", b"", 0), 100, "frame count"),
        (ProcessResult(0, b"0.1\n0.2\n", b"", 0), 1, "frame count"),
    ],
)
def test_source_frame_metadata_rejects_bad_probe_output(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    case: tuple[ProcessResult, int, str],
) -> None:
    result, max_frames, message = case
    limited = replace(settings, limits=replace(settings.limits, max_frames=max_frames))
    monkeypatch.setattr(
        preparation_module,
        "run_bounded_process",
        lambda *_args, **_kwargs: result,
    )
    with pytest.raises(ValueError, match=message):
        preparation_module._source_frames(
            tmp_path / "source.mp4",
            RaceWindow(startTimestampMs=100, endTimestampMs=400),
            _metadata(),
            limited,
            time.monotonic() + 10,
        )


def test_source_frame_metadata_rejects_non_monotonic_timestamps(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        preparation_module,
        "run_bounded_process",
        lambda *_args, **_kwargs: ProcessResult(0, b"0.2\n0.1\n", b"", 0),
    )
    with pytest.raises(ValueError, match="not ordered"):
        preparation_module._source_frames(
            tmp_path / "source.mp4",
            RaceWindow(startTimestampMs=100, endTimestampMs=400),
            _metadata(),
            settings,
            time.monotonic() + 10,
        )


def test_real_vfr_non_aligned_window_preserves_source_provenance(
    settings: ServiceSettings,
    tmp_path: Path,
) -> None:
    source = tmp_path / "vfr.mp4"
    prepared = tmp_path / "prepared.mp4"
    subprocess.run(  # noqa: S603 - fixed test-only FFmpeg command
        (
            "/usr/bin/ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=160x90:r=10:d=0.7",
            "-vf",
            "select=eq(n\\,0)+eq(n\\,1)+eq(n\\,3)+eq(n\\,6)",
            "-vsync",
            "vfr",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-y",
            str(source),
        ),
        check=True,
        capture_output=True,
    )
    metadata = replace(
        _metadata(duration_ms=700),
        average_frame_rate=Fraction(40, 7),
    )
    window = RaceWindow(startTimestampMs=150, endTimestampMs=650)
    deadline = time.monotonic() + 10
    frames = preparation_module._source_frames(
        source,
        window,
        metadata,
        settings,
        deadline,
    )
    assert [(frame.frame_index, frame.timestamp_ms) for frame in frames] == [
        (2, 300),
        (3, 600),
    ]
    preparation_module._prepare_track_view(
        source,
        prepared,
        window,
        metadata,
        settings,
        deadline,
    )
    assert preparation_module._prepared_frame_count(
        prepared,
        settings,
        deadline,
    ) == len(frames)


@pytest.mark.parametrize(
    "result",
    [ProcessResult(1, b"", b"", 0), ProcessResult(0, b"invalid", b"", 0)],
)
def test_prepared_frame_count_rejects_invalid_output(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    result: ProcessResult,
) -> None:
    monkeypatch.setattr(
        preparation_module,
        "run_bounded_process",
        lambda *_args, **_kwargs: result,
    )
    with pytest.raises(ValueError, match="frame count"):
        preparation_module._prepared_frame_count(
            tmp_path / "prepared.mp4",
            settings,
            time.monotonic() + 10,
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
        tracking_module._extract_frames(
            tmp_path / "prepared.mp4", output, settings, time.monotonic() + 10
        )


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
        tracking_module._extract_frames(
            tmp_path / "prepared.mp4", output, limited, time.monotonic() + 10
        )


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
    path = _manifest_path(settings)
    path.write_bytes(raw)
    with pytest.raises(InvalidArtifactError):
        tracking_module._load_frame_manifest(
            request,
            settings,
            time.monotonic() + 10,
        )


def _request_with_manifest_bytes(raw: bytes) -> TrackStageRequest:
    request = _track_request()
    prepared = request.prepared.model_copy(
        update={
            "frame_manifest_byte_count": len(raw),
            "frame_manifest_checksum_sha256": hashlib.sha256(raw).hexdigest(),
        }
    )
    return request.model_copy(update={"prepared": prepared})


def _manifest_path(settings: ServiceSettings) -> Path:
    bundle = settings.artifact_root / f"{PREPARED_MEDIA_ID}{PREPARED_BUNDLE_SUFFIX}"
    bundle.mkdir(exist_ok=True)
    return bundle / f"{PREPARED_MEDIA_ID}{FRAME_MANIFEST_SUFFIX}"


def test_frame_manifest_rejects_decompression_limit_and_descriptor_mismatch(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings.prepare_roots()
    raw = gzip.compress(b"1234567890", mtime=0)
    request = _request_with_manifest_bytes(raw)
    path = _manifest_path(settings)
    path.write_bytes(raw)
    monkeypatch.setattr(tracking_module, "MAX_MANIFEST_BYTES", 5)
    with pytest.raises(InvalidArtifactError):
        tracking_module._load_frame_manifest(
            request,
            settings,
            time.monotonic() + 10,
        )

    monkeypatch.setattr(tracking_module, "MAX_MANIFEST_BYTES", 64 * 1024 * 1024)
    manifest_raw = gzip.compress(
        artifact_module.canonical_json(
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
        tracking_module._load_frame_manifest(
            mismatch,
            settings,
            time.monotonic() + 10,
        )


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
        preparation_module,
        "run_bounded_process",
        lambda *_args, **_kwargs: result,
    )
    with pytest.raises(ValueError, match=message):
        preparation_module._ffmpeg_version(settings, time.monotonic() + 10)


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

    monkeypatch.setattr(artifact_module, "_write_all", fail_write)
    with pytest.raises(PermissionError, match="write failed"):
        artifact_module.publish_bytes(b"value", destination)
    assert list(settings.artifact_root.iterdir()) == []
    monkeypatch.undo()

    missing = artifact_module.PublishedArtifact(
        destination,
        0,
        SHA,
        created=False,
    )
    artifact_module.remove_published(missing)
    destination.mkdir()
    artifact_module.remove_published(missing)
    assert destination.is_dir()
    destination.rmdir()
    destination.write_bytes(b"value")
    artifact_module.remove_published(missing)
    assert not destination.exists()

    source = tmp_path / "source"
    source.write_bytes(b"value")
    digest = hashlib.sha256(b"value").hexdigest()
    with pytest.raises(InvalidArtifactError):
        artifact_module.read_verified_artifact(
            source,
            expected_bytes=5,
            expected_checksum=digest,
            max_bytes=1,
        )
    with pytest.raises(InvalidArtifactError):
        artifact_module.read_verified_artifact(
            source,
            expected_bytes=4,
            expected_checksum=digest,
            max_bytes=10,
        )

    with pytest.raises(InvalidArtifactError):
        artifact_module.copy_verified_artifact(
            source,
            tmp_path / "copy-too-large",
            expected_bytes=5,
            expected_checksum=digest,
            max_bytes=1,
        )
    with pytest.raises(InvalidArtifactError):
        artifact_module.copy_verified_artifact(
            source,
            tmp_path / "copy-mismatch",
            expected_bytes=4,
            expected_checksum=digest,
            max_bytes=10,
        )

    with pytest.raises(InvalidArtifactError):
        artifact_module._open_artifact(tmp_path / "missing")
    with pytest.raises(InvalidArtifactError):
        artifact_module._open_artifact(destination)

    empty = tmp_path / "empty"
    empty.write_bytes(b"")
    with pytest.raises(ValueError, match="empty"):
        artifact_module.file_digest(empty, max_bytes=10)
    with pytest.raises(ProcessOutputLimitError):
        artifact_module.file_digest(source, max_bytes=1)

    first = artifact_module.publish_bytes(b"value", destination)
    second = artifact_module.publish_bytes(b"value", destination)
    assert first.created is True
    assert second.created is False
    with pytest.raises(ArtifactConflictError):
        artifact_module.publish_bytes(b"different", destination)
    destination.unlink()
    destination.mkdir()
    with pytest.raises(ArtifactConflictError):
        artifact_module.publish_bytes(b"value", destination)


def test_bundle_and_completion_validation_defenses(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings.prepare_roots()
    with pytest.raises(InvalidArtifactError):
        artifact_module.bundle_member_path(
            settings, PREPARED_MEDIA_ID, ".missing", ".x"
        )

    not_directory = settings.artifact_root / f"{PREPARED_MEDIA_ID}.not-directory"
    not_directory.write_bytes(b"x")
    with pytest.raises(InvalidArtifactError):
        artifact_module.bundle_member_path(
            settings,
            PREPARED_MEDIA_ID,
            ".not-directory",
            ".x",
        )

    invalid_completion = tmp_path / "invalid.json"
    invalid_completion.write_bytes(b"not-json")
    with pytest.raises(InvalidArtifactError):
        artifact_module.read_completion(
            invalid_completion,
            PrepareStageAccepted,
            max_bytes=100,
        )

    def deny_rename(_self: Path, _destination: Path) -> Path:
        raise PermissionError

    monkeypatch.setattr(Path, "rename", deny_rename)
    with pytest.raises(PermissionError):
        artifact_module.publish_bundle(
            settings.artifact_root / "denied.bundle",
            {"member": b"value"},
        )


def test_stage_deadlines_reject_expired_work() -> None:
    expired = time.monotonic() - 1
    with pytest.raises(ProcessTimeoutError):
        remaining_seconds(expired)
    with pytest.raises(ProcessTimeoutError):
        remaining_seconds(expired)


def test_write_all_rejects_zero_byte_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(os, "write", lambda _descriptor, _value: 0)
    with pytest.raises(OSError, match="Unable to write artifact"):
        artifact_module._write_all(1, b"value")


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
