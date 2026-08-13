# Provider, media, and artifact details are mapped to canonical safe errors
# before leaving this module.
import hashlib
import tempfile
import threading
import time
from pathlib import Path
from typing import Literal

from pydantic import ValidationError

from driving_analysis_service.contracts import (
    MAX_SUBJECT_OBSERVATIONS,
    NormalizedBox,
    NormalizedPoint,
    SubjectObservation,
)
from driving_analysis_service.inference import (
    InferenceFailureError,
    InferenceFrame,
    InferenceProvider,
    InferenceUnavailableError,
)
from driving_analysis_service.processes import (
    ProcessOutputLimitError,
    ProcessTimeoutError,
    run_bounded_process,
)
from driving_analysis_service.processing_errors import rejected, tracking_error_code
from driving_analysis_service.settings import ServiceSettings
from driving_analysis_service.tracking_artifacts import (
    FRAME_MANIFEST_SUFFIX,
    MAX_COMPRESSED_MANIFEST_BYTES,
    MAX_MANIFEST_BYTES,
    MAX_OBSERVATION_SEGMENT_BYTES,
    OBSERVATION_BUNDLE_SUFFIX,
    OBSERVATION_COMPLETION_SUFFIX,
    OBSERVATION_SEGMENT_SUFFIX,
    PREPARED_BUNDLE_SUFFIX,
    PREPARED_MEDIA_SUFFIX,
    ArtifactConflictError,
    InvalidArtifactError,
    bundle_member_path,
    bundle_path,
    canonical_json,
    compressed_contract,
    copy_verified_artifact,
    file_digest,
    publish_bundle,
    read_completion,
    read_compressed_contract,
)
from driving_analysis_service.tracking_contracts import (
    PROCESSING_CONTRACT_VERSION,
    ObservationSegmentArtifact,
    OpenTrackingGap,
    PreparedFrameManifest,
    PreparedMediaArtifact,
    ProviderCandidate,
    SubjectObservationSegment,
    TrackStageAccepted,
    TrackStageRequest,
    TrackStageResponse,
)

MAX_COMPLETION_BYTES = 64 * 1024


class SubjectTrackingService:
    def __init__(
        self,
        settings: ServiceSettings,
        provider: InferenceProvider,
        admission: threading.BoundedSemaphore | None = None,
    ) -> None:
        self.settings = settings
        self.provider = provider
        self._admission = admission or threading.BoundedSemaphore(
            settings.limits.max_concurrent_processing
        )

    def track(self, request: TrackStageRequest) -> TrackStageResponse:
        if not self._admission.acquire(blocking=False):
            return rejected(request, "RESOURCE_LIMIT")
        try:
            return self._track(request)
        except (
            ArtifactConflictError,
            InferenceFailureError,
            InferenceUnavailableError,
            InvalidArtifactError,
            OSError,
            ProcessOutputLimitError,
            ProcessTimeoutError,
            ValidationError,
            ValueError,
        ) as error:
            return rejected(request, tracking_error_code(error))
        finally:
            self._admission.release()

    def _track(self, request: TrackStageRequest) -> TrackStageAccepted:
        self.settings.prepare_roots()
        completed = _recover_completed_segment(request, self.settings)
        if completed is not None:
            return _accepted(request, completed)
        if (
            request.prepared.window.end_timestamp_ms
            - request.prepared.window.start_timestamp_ms
            > self.settings.limits.max_race_window_ms
        ):
            raise ProcessOutputLimitError
        if not self.provider.ready():
            raise InferenceUnavailableError
        provenance = self.provider.provenance
        deadline = time.monotonic() + self.settings.limits.process_timeout_seconds
        with tempfile.TemporaryDirectory(
            prefix="track-", dir=self.settings.work_root
        ) as raw_work_directory:
            work_directory = Path(raw_work_directory)
            prepared_path = work_directory / "prepared.mp4"
            copy_verified_artifact(
                bundle_member_path(
                    self.settings,
                    request.prepared.prepared_media_id,
                    PREPARED_BUNDLE_SUFFIX,
                    PREPARED_MEDIA_SUFFIX,
                ),
                prepared_path,
                expected_bytes=request.prepared.byte_count,
                expected_checksum=request.prepared.checksum_sha256,
                max_bytes=self.settings.limits.max_bytes,
            )
            manifest = _load_frame_manifest(request, self.settings)
            frame_directory = work_directory / "frames"
            frame_directory.mkdir(mode=0o700)
            frame_paths = _extract_frames(
                prepared_path,
                frame_directory,
                self.settings,
                deadline,
            )
            if len(frame_paths) != len(manifest.frames):
                raise InvalidArtifactError
            seed_position = _seed_position(request, manifest)
            observations, gap = self._observe(
                request,
                manifest,
                frame_paths,
                seed_position,
                deadline,
            )
            if not self.provider.ready() or self.provider.provenance != provenance:
                raise InferenceUnavailableError

        envelope = SubjectObservationSegment(
            contractVersion="subject-observation-segment.v1",
            outcome="accepted",
            caseId=request.case_id,
            observations=observations,
            openGap=gap,
            provenance=provenance,
        )
        segment_bytes = compressed_contract(envelope)
        if len(segment_bytes) > MAX_OBSERVATION_SEGMENT_BYTES:
            raise ProcessOutputLimitError
        segment_checksum = hashlib.sha256(segment_bytes).hexdigest()
        segment = _segment_descriptor(
            request,
            envelope,
            len(segment_bytes),
            segment_checksum,
        )
        created = publish_bundle(
            bundle_path(
                self.settings,
                request.observation_segment_id,
                OBSERVATION_BUNDLE_SUFFIX,
            ),
            {
                f"{request.observation_segment_id}{OBSERVATION_SEGMENT_SUFFIX}": (
                    segment_bytes
                ),
                f"{request.observation_segment_id}{OBSERVATION_COMPLETION_SUFFIX}": (
                    canonical_json(segment.model_dump(mode="json", by_alias=True))
                ),
            },
        )
        if not created:
            recovered = _recover_completed_segment(request, self.settings)
            if recovered != segment:
                raise ArtifactConflictError
            segment = recovered
        return _accepted(request, segment)

    def _observe(
        self,
        request: TrackStageRequest,
        manifest: PreparedFrameManifest,
        frame_paths: tuple[Path, ...],
        seed_position: int,
        deadline: float,
    ) -> tuple[tuple[SubjectObservation, ...], OpenTrackingGap | None]:
        observations: list[SubjectObservation] = []
        previous_box: NormalizedBox | None = None
        gap: OpenTrackingGap | None = None
        seed_frame = InferenceFrame(
            image_path=frame_paths[seed_position],
            provenance=manifest.frames[seed_position],
        )
        threshold = self.provider.provenance.identity_confidence_threshold
        for frame_path, frame_provenance in zip(
            frame_paths[seed_position:],
            manifest.frames[seed_position:],
            strict=True,
        ):
            if len(observations) >= MAX_SUBJECT_OBSERVATIONS:
                raise ProcessOutputLimitError
            candidate = self.provider.infer(
                seed_frame=seed_frame,
                frame=InferenceFrame(frame_path, frame_provenance),
                seed=request.subject_seed,
                previous_box=previous_box,
                timeout_seconds=_remaining_seconds(deadline),
            )
            box = _trusted_box(candidate, threshold)
            if box is None:
                gap = OpenTrackingGap(
                    startTimestampMs=frame_provenance.timestamp_ms,
                    reason=_gap_reason(candidate),
                )
                break
            previous_box = box
            observations.append(
                SubjectObservation(
                    timestampMs=frame_provenance.timestamp_ms,
                    frameIndex=frame_provenance.frame_index,
                    box=box,
                    center=NormalizedPoint(
                        x=box.x + box.width / 2,
                        y=box.y + box.height / 2,
                    ),
                    visibility=candidate.visibility,
                    identityConfidence=candidate.identity_confidence,
                    origin="detected",
                    provenance=self.provider.provenance,
                )
            )
        return tuple(observations), gap


def _accepted(
    request: TrackStageRequest,
    segment: ObservationSegmentArtifact,
) -> TrackStageAccepted:
    return TrackStageAccepted(
        contractVersion=PROCESSING_CONTRACT_VERSION,
        correlationId=request.correlation_id,
        outcome="accepted",
        caseId=request.case_id,
        segment=segment,
    )


def _recover_completed_segment(
    request: TrackStageRequest,
    settings: ServiceSettings,
) -> ObservationSegmentArtifact | None:
    bundle = bundle_path(
        settings,
        request.observation_segment_id,
        OBSERVATION_BUNDLE_SUFFIX,
    )
    if not bundle.exists():
        return None
    completed = read_completion(
        bundle_member_path(
            settings,
            request.observation_segment_id,
            OBSERVATION_BUNDLE_SUFFIX,
            OBSERVATION_COMPLETION_SUFFIX,
        ),
        ObservationSegmentArtifact,
        max_bytes=MAX_COMPLETION_BYTES,
    )
    if completed is None:
        return None
    if not _segment_matches_request(completed, request):
        raise ArtifactConflictError
    checksum, byte_count = file_digest(
        bundle_member_path(
            settings,
            request.observation_segment_id,
            OBSERVATION_BUNDLE_SUFFIX,
            OBSERVATION_SEGMENT_SUFFIX,
        ),
        max_bytes=MAX_OBSERVATION_SEGMENT_BYTES,
    )
    if (byte_count, checksum) != (completed.byte_count, completed.checksum_sha256):
        raise InvalidArtifactError
    return completed


def _segment_descriptor(
    request: TrackStageRequest,
    envelope: SubjectObservationSegment,
    byte_count: int,
    checksum: str,
) -> ObservationSegmentArtifact:
    return ObservationSegmentArtifact(
        observationSegmentId=request.observation_segment_id,
        caseId=request.case_id,
        byteCount=byte_count,
        checksumSha256=checksum,
        contentEncoding="gzip",
        mediaType="application/vnd.rc-mech.subject-observations+json",
        observationCount=len(envelope.observations),
        completed=envelope.open_gap is None,
        gap=envelope.open_gap,
        provenance=envelope.provenance,
        ffmpegVersion=request.prepared.ffmpeg_version,
        sourceChecksumSha256=request.prepared.source_checksum_sha256,
        preparedChecksumSha256=request.prepared.checksum_sha256,
        preparationConfigurationDigest=request.prepared.preparation_configuration_digest,
    )


def _segment_matches_request(
    segment: ObservationSegmentArtifact,
    request: TrackStageRequest,
) -> bool:
    return (
        segment.observation_segment_id == request.observation_segment_id
        and segment.case_id == request.case_id
        and segment.ffmpeg_version == request.prepared.ffmpeg_version
        and segment.source_checksum_sha256 == request.prepared.source_checksum_sha256
        and segment.prepared_checksum_sha256 == request.prepared.checksum_sha256
        and segment.preparation_configuration_digest
        == request.prepared.preparation_configuration_digest
    )


def _extract_frames(
    prepared_path: Path,
    frame_directory: Path,
    settings: ServiceSettings,
    deadline: float,
) -> tuple[Path, ...]:
    result = run_bounded_process(
        settings.ffmpeg_executable,
        (
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-xerror",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            ",".join(settings.limits.supported_demuxers),
            "-i",
            str(prepared_path),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-vsync",
            "0",
            "-frames:v",
            str(settings.limits.max_frames + 1),
            "-start_number",
            "0",
            "-q:v",
            "2",
            str(frame_directory / "%08d.jpg"),
        ),
        timeout_seconds=_remaining_seconds(deadline),
        max_output_bytes=settings.limits.max_process_output_bytes,
    )
    if result.return_code != 0:
        raise InferenceFailureError
    frames = tuple(sorted(frame_directory.glob("*.jpg")))
    if not frames or len(frames) > settings.limits.max_frames:
        raise InferenceFailureError
    return frames


def _load_frame_manifest(
    request: TrackStageRequest,
    settings: ServiceSettings,
) -> PreparedFrameManifest:
    manifest = read_compressed_contract(
        bundle_member_path(
            settings,
            request.prepared.prepared_media_id,
            PREPARED_BUNDLE_SUFFIX,
            FRAME_MANIFEST_SUFFIX,
        ),
        PreparedFrameManifest,
        expected_bytes=request.prepared.frame_manifest_byte_count,
        expected_checksum=request.prepared.frame_manifest_checksum_sha256,
        max_compressed_bytes=MAX_COMPRESSED_MANIFEST_BYTES,
        max_decompressed_bytes=MAX_MANIFEST_BYTES,
    )
    if not _manifest_matches_descriptor(manifest, request.prepared):
        raise InvalidArtifactError
    return manifest


def _manifest_matches_descriptor(
    manifest: PreparedFrameManifest,
    descriptor: PreparedMediaArtifact,
) -> bool:
    return (
        manifest.prepared_media_id == descriptor.prepared_media_id
        and manifest.case_id == descriptor.case_id
        and manifest.source_checksum_sha256 == descriptor.source_checksum_sha256
        and manifest.source_byte_count == descriptor.source_byte_count
        and manifest.window == descriptor.window
        and manifest.track_view == descriptor.track_view
        and manifest.media_byte_count == descriptor.byte_count
        and manifest.media_checksum_sha256 == descriptor.checksum_sha256
        and manifest.width == descriptor.width
        and manifest.height == descriptor.height
        and len(manifest.frames) == descriptor.decoded_frame_count
        and manifest.average_frame_rate == descriptor.average_frame_rate
        and manifest.ffmpeg_version == descriptor.ffmpeg_version
        and manifest.pipeline_version == descriptor.pipeline_version
        and manifest.preparation_configuration_digest
        == descriptor.preparation_configuration_digest
    )


def _seed_position(
    request: TrackStageRequest,
    manifest: PreparedFrameManifest,
) -> int:
    for index, frame in enumerate(manifest.frames):
        if (
            frame.frame_index == request.subject_seed.frame_index
            and frame.timestamp_ms == request.subject_seed.timestamp_ms
        ):
            return index
    raise InvalidArtifactError


def _trusted_box(
    candidate: ProviderCandidate,
    threshold: float,
) -> NormalizedBox | None:
    if (
        candidate.box is None
        or candidate.visibility != "visible"
        or candidate.identity_confidence < threshold
    ):
        return None
    return candidate.box


def _gap_reason(
    candidate: ProviderCandidate,
) -> Literal["ambiguous-identity", "occluded", "missing"]:
    if candidate.visibility == "occluded":
        return "occluded"
    if candidate.box is None:
        return "missing"
    return "ambiguous-identity"


def _remaining_seconds(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProcessTimeoutError
    return remaining
