import threading
from collections.abc import Generator
from pathlib import Path

import pytest
from driving_analysis_service.contracts import SubjectProvenance, SubjectSeed
from driving_analysis_service.inference import InferenceFrame
from driving_analysis_service.tracking_artifacts import (
    FRAME_MANIFEST_SUFFIX,
    MAX_COMPRESSED_MANIFEST_BYTES,
    OBSERVATION_BUNDLE_SUFFIX,
    OBSERVATION_SEGMENT_SUFFIX,
    PREPARED_BUNDLE_SUFFIX,
    PREPARED_MEDIA_SUFFIX,
    bundle_member_path,
    bundle_path,
    read_artifact,
)
from driving_analysis_service.tracking_contracts import (
    PreparedFrame,
    ProviderCandidate,
    TrackStageAccepted,
    TrackStageRequest,
)

import chassis_notes_gpu_worker.executor as executor_module
from chassis_notes_gpu_worker.contracts import OutputArtifact
from chassis_notes_gpu_worker.executor import (
    ExecutionInput,
    Sam31TrackingExecutor,
    TrackingExecutionError,
    _CancellableProvider,
)
from chassis_notes_gpu_worker.profile import InferenceProfile
from tests.conftest import (
    MANIFEST_BYTES,
    MEDIA_BYTES,
    ArtifactFactory,
    SubmissionFactory,
)


class _Provider:
    def __init__(self, provenance: SubjectProvenance) -> None:
        self._provenance = provenance
        self.is_ready = True
        self.emit_candidate = True
        self.closed_streams = 0

    @property
    def provenance(self) -> SubjectProvenance:
        return self._provenance

    def ready(self, *, timeout_seconds: float | None = None) -> bool:
        assert timeout_seconds in {None, 2.0}
        return self.is_ready

    def track_segment(
        self,
        *,
        seed_frame: InferenceFrame,
        frames: tuple[InferenceFrame, ...],
        seed: SubjectSeed,
        timeout_seconds: float | None = None,
    ) -> Generator[ProviderCandidate]:
        del seed_frame, frames, timeout_seconds
        try:
            if not self.emit_candidate:
                return
            yield ProviderCandidate(
                box=seed.box,
                identityConfidence=1.0,
                visibility="visible",
            )
        finally:
            self.closed_streams += 1


def _frame() -> InferenceFrame:
    return InferenceFrame(
        image_path=Path("000000000000.jpg"),
        provenance=PreparedFrame(
            preparedFrameIndex=0,
            frameIndex=1,
            timestampMs=100,
        ),
    )


def test_cancellable_provider_forwards_provenance_readiness_and_candidates(
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
) -> None:
    submission = submission_factory()
    provider = _Provider(artifact_factory(submission).segment.provenance)
    cancelled = threading.Event()
    wrapped = _CancellableProvider(provider, cancelled)
    frame = _frame()

    assert wrapped.provenance == provider.provenance
    assert wrapped.ready(timeout_seconds=2.0) is True
    stream = wrapped.track_segment(
        seed_frame=frame,
        frames=(frame,),
        seed=submission.tracking_request.subject_seed,
        timeout_seconds=2.0,
    )
    candidate = next(stream)
    stream.close()
    assert candidate.box == submission.tracking_request.subject_seed.box
    assert provider.closed_streams == 1

    provider.emit_candidate = False
    assert (
        list(
            wrapped.track_segment(
                seed_frame=frame,
                frames=(frame,),
                seed=submission.tracking_request.subject_seed,
            )
        )
        == []
    )
    assert provider.closed_streams == 2

    provider.is_ready = False
    assert wrapped.ready() is False
    provider.emit_candidate = True
    cancelled.set()
    assert wrapped.ready() is False
    with pytest.raises(TrackingExecutionError):
        next(
            wrapped.track_segment(
                seed_frame=frame,
                frames=(frame,),
                seed=submission.tracking_request.subject_seed,
            )
        )
    assert provider.closed_streams == 3


class _TrackingService:
    response: TrackStageAccepted | object
    cancel_during_track: threading.Event | None = None
    copied_media: bytes | None = None
    copied_manifest: bytes | None = None

    def __init__(self, settings: object, provider: object) -> None:
        self.settings = settings
        self.provider = provider

    def track(self, request: TrackStageRequest) -> TrackStageAccepted | object:
        settings = self.settings
        prepared_id = request.prepared.prepared_media_id
        _TrackingService.copied_media = read_artifact(
            bundle_member_path(
                settings,
                prepared_id,
                PREPARED_BUNDLE_SUFFIX,
                PREPARED_MEDIA_SUFFIX,
            ),
            max_bytes=request.prepared.byte_count,
        )
        _TrackingService.copied_manifest = read_artifact(
            bundle_member_path(
                settings,
                prepared_id,
                PREPARED_BUNDLE_SUFFIX,
                FRAME_MANIFEST_SUFFIX,
            ),
            max_bytes=MAX_COMPRESSED_MANIFEST_BYTES,
        )
        response = _TrackingService.response
        if isinstance(response, TrackStageAccepted):
            bundle_path(
                settings,
                request.observation_segment_id,
                OBSERVATION_BUNDLE_SUFFIX,
            ).mkdir(mode=0o700)
            output = bundle_member_path(
                settings,
                request.observation_segment_id,
                OBSERVATION_BUNDLE_SUFFIX,
                OBSERVATION_SEGMENT_SUFFIX,
            )
            output.path.write_bytes(b"observations")
        if _TrackingService.cancel_during_track is not None:
            _TrackingService.cancel_during_track.set()
        return response


def _executor(
    profile: InferenceProfile,
    artifact: OutputArtifact,
) -> Sam31TrackingExecutor:
    return Sam31TrackingExecutor(
        profile,
        Path("unused-checkpoint.pt"),
        provider=_Provider(artifact.segment.provenance),
    )


def test_executor_reuses_the_preserved_tracking_service_contract(
    tmp_path: Path,
    profile: InferenceProfile,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    submission = submission_factory()
    artifact = artifact_factory(submission)
    _TrackingService.response = TrackStageAccepted(
        contractVersion="subject-tracking.v1",
        correlationId=submission.tracking_request.correlation_id,
        outcome="accepted",
        caseId=submission.tracking_request.case_id,
        segment=artifact.segment,
    )
    _TrackingService.cancel_during_track = None
    monkeypatch.setattr(executor_module, "SubjectTrackingService", _TrackingService)
    prepared_media = tmp_path / "prepared.track.mp4"
    frame_manifest = tmp_path / "prepared.frames.json.gz"
    prepared_media.write_bytes(MEDIA_BYTES)
    frame_manifest.write_bytes(MANIFEST_BYTES)

    result = _executor(profile, artifact).execute(
        submission,
        ExecutionInput(prepared_media, frame_manifest),
        tmp_path / "job",
        threading.Event(),
    )

    assert result.artifact == artifact
    assert result.path.read_bytes() == b"observations"
    assert _TrackingService.copied_media == MEDIA_BYTES
    assert _TrackingService.copied_manifest == MANIFEST_BYTES


def test_executor_rejects_cancellation_and_nonaccepted_results(
    tmp_path: Path,
    profile: InferenceProfile,
    submission_factory: SubmissionFactory,
    artifact_factory: ArtifactFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    submission = submission_factory()
    artifact = artifact_factory(submission)
    executor = _executor(profile, artifact)
    inputs = ExecutionInput(tmp_path / "prepared.track.mp4", tmp_path / "frames.gz")
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(TrackingExecutionError):
        executor.execute(submission, inputs, tmp_path / "cancelled", cancelled)

    inputs.prepared_media.write_bytes(MEDIA_BYTES)
    inputs.frame_manifest.write_bytes(MANIFEST_BYTES)
    _TrackingService.response = object()
    _TrackingService.cancel_during_track = None
    monkeypatch.setattr(executor_module, "SubjectTrackingService", _TrackingService)
    with pytest.raises(TrackingExecutionError):
        executor.execute(submission, inputs, tmp_path / "rejected", threading.Event())

    _TrackingService.response = TrackStageAccepted(
        contractVersion="subject-tracking.v1",
        correlationId=submission.tracking_request.correlation_id,
        outcome="accepted",
        caseId=submission.tracking_request.case_id,
        segment=artifact.segment,
    )
    cancelled_during_track = threading.Event()
    _TrackingService.cancel_during_track = cancelled_during_track
    with pytest.raises(TrackingExecutionError):
        executor.execute(
            submission,
            inputs,
            tmp_path / "cancelled-during-track",
            cancelled_during_track,
        )


def test_default_executor_reports_an_uninstalled_checkpoint_unready(
    tmp_path: Path,
    profile: InferenceProfile,
) -> None:
    executor = Sam31TrackingExecutor(profile, tmp_path / "missing.pt")

    assert executor.ready() is False
