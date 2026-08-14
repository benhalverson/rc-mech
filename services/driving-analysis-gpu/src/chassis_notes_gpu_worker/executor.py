import shutil
import threading
from collections.abc import Generator
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from driving_analysis_service.contracts import SubjectProvenance, SubjectSeed
from driving_analysis_service.inference import (
    InferenceFrame,
    InferenceProvider,
)
from driving_analysis_service.sam31_inference import Sam31InferenceProvider
from driving_analysis_service.settings import (
    InferenceSettings,
    MediaLimits,
    ServiceSettings,
)
from driving_analysis_service.tracking import SubjectTrackingService
from driving_analysis_service.tracking_artifacts import (
    FRAME_MANIFEST_SUFFIX,
    OBSERVATION_BUNDLE_SUFFIX,
    OBSERVATION_SEGMENT_SUFFIX,
    PREPARED_BUNDLE_SUFFIX,
    PREPARED_MEDIA_SUFFIX,
    bundle_member_path,
    bundle_path,
)
from driving_analysis_service.tracking_contracts import (
    ProviderCandidate,
    TrackStageAccepted,
)

from chassis_notes_gpu_worker.contracts import OutputArtifact, TrackingJobSubmission
from chassis_notes_gpu_worker.profile import InferenceProfile


class TrackingExecutionError(RuntimeError):
    """A local Tracking execution failed without exposing provider detail."""


@dataclass(frozen=True)
class ExecutionInput:
    prepared_media: Path
    frame_manifest: Path


@dataclass(frozen=True)
class ExecutionOutput:
    artifact: OutputArtifact
    path: Path


class TrackingExecutor(Protocol):
    def execute(
        self,
        submission: TrackingJobSubmission,
        inputs: ExecutionInput,
        job_root: Path,
        cancelled: threading.Event,
    ) -> ExecutionOutput: ...


class _CancellableProvider:
    def __init__(
        self,
        provider: InferenceProvider,
        cancelled: threading.Event,
    ) -> None:
        self._provider = provider
        self._cancelled = cancelled

    @property
    def provenance(self) -> SubjectProvenance:
        return self._provider.provenance

    def ready(self, *, timeout_seconds: float | None = None) -> bool:
        return not self._cancelled.is_set() and self._provider.ready(
            timeout_seconds=timeout_seconds
        )

    def track_segment(
        self,
        *,
        seed_frame: InferenceFrame,
        frames: tuple[InferenceFrame, ...],
        seed: SubjectSeed,
        timeout_seconds: float | None = None,
    ) -> Generator[ProviderCandidate]:
        stream = self._provider.track_segment(
            seed_frame=seed_frame,
            frames=frames,
            seed=seed,
            timeout_seconds=timeout_seconds,
        )
        try:
            for candidate in stream:
                if self._cancelled.is_set():
                    raise TrackingExecutionError
                yield candidate
        finally:
            stream.close()


class Sam31TrackingExecutor:
    def __init__(
        self,
        profile: InferenceProfile,
        checkpoint_path: Path,
        *,
        provider: InferenceProvider | None = None,
    ) -> None:
        settings = InferenceSettings(
            provider="sam31",
            model=profile.model.name,
            model_version=profile.model.version,
            model_digest=profile.model.digest,
            confidence_calibration=profile.confidence_calibration,
            identity_confidence_threshold=profile.identity_confidence_threshold,
            checkpoint_path=checkpoint_path,
        )
        self._provider = provider or Sam31InferenceProvider.create(settings)

    def ready(self) -> bool:
        return self._provider.ready()

    def execute(
        self,
        submission: TrackingJobSubmission,
        inputs: ExecutionInput,
        job_root: Path,
        cancelled: threading.Event,
    ) -> ExecutionOutput:
        if cancelled.is_set():
            raise TrackingExecutionError
        service_root = job_root / "execution"
        settings = ServiceSettings(
            staging_root=service_root / "staged",
            work_root=service_root / "work",
            artifact_root=service_root / "artifacts",
            limits=replace(
                MediaLimits(),
                process_timeout_seconds=24 * 60 * 60,
                max_concurrent_processing=1,
            ),
        )
        settings.prepare_roots()
        prepared_id = submission.tracking_request.prepared.prepared_media_id
        prepared_bundle = bundle_path(settings, prepared_id, PREPARED_BUNDLE_SUFFIX)
        prepared_bundle.mkdir(mode=0o700)
        shutil.copyfile(
            inputs.prepared_media,
            prepared_bundle / f"{prepared_id}{PREPARED_MEDIA_SUFFIX}",
        )
        shutil.copyfile(
            inputs.frame_manifest,
            prepared_bundle / f"{prepared_id}{FRAME_MANIFEST_SUFFIX}",
        )
        service = SubjectTrackingService(
            settings,
            _CancellableProvider(self._provider, cancelled),
        )
        response = service.track(submission.tracking_request)
        if not isinstance(response, TrackStageAccepted) or cancelled.is_set():
            raise TrackingExecutionError
        segment = response.segment
        output_path = bundle_member_path(
            settings,
            submission.segment_id,
            OBSERVATION_BUNDLE_SUFFIX,
            OBSERVATION_SEGMENT_SUFFIX,
        )
        return ExecutionOutput(
            artifact=OutputArtifact(
                contractVersion="tracking-artifact.v1",
                runId=submission.run_id,
                segmentId=submission.segment_id,
                attemptId=submission.attempt_id,
                leaseId=submission.lease_id,
                fencingToken=submission.fencing_token,
                specificationDigest=submission.specification_digest,
                profileDigest=submission.profile_digest,
                segment=segment,
            ),
            path=output_path,
        )
