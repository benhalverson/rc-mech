# Internal media/provider validation messages are always mapped to canonical
# safe errors before leaving this module.
# ruff: noqa: EM101, TRY003

import gzip
import hashlib
import io
import json
import os
import stat
import tempfile
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from fractions import Fraction
from pathlib import Path
from typing import BinaryIO, Literal

from pydantic import BaseModel, ValidationError

from driving_analysis_service.contracts import (
    MAX_SUBJECT_OBSERVATIONS,
    AcceptedSubjectObservations,
    NormalizedBox,
    NormalizedPoint,
    RationalValue,
    SubjectObservation,
    TrackingGap,
)
from driving_analysis_service.errors import MediaValidationError
from driving_analysis_service.inference import (
    InferenceFailureError,
    InferenceFrame,
    InferenceProvider,
    InferenceUnavailableError,
)
from driving_analysis_service.media import (
    ProbeMetadata,
    claim_staged_media,
    inspect_and_probe_media,
)
from driving_analysis_service.processes import (
    ProcessOutputLimitError,
    ProcessTimeoutError,
    run_bounded_process,
)
from driving_analysis_service.settings import ServiceSettings
from driving_analysis_service.tracking_contracts import (
    PROCESSING_CONTRACT_VERSION,
    TRACK_VIEW_HEIGHT,
    TRACK_VIEW_Y,
    FixedTrackView,
    ObservationSegmentArtifact,
    PreparedFrame,
    PreparedFrameManifest,
    PreparedMediaArtifact,
    PrepareStageAccepted,
    PrepareStageRequest,
    PrepareStageResponse,
    ProcessingErrorCode,
    ProcessingRejected,
    ProviderCandidate,
    RaceWindow,
    TrackStageAccepted,
    TrackStageRequest,
    TrackStageResponse,
)

PREPARED_MEDIA_SUFFIX = ".track.mp4"
FRAME_MANIFEST_SUFFIX = ".frames.json.gz"
OBSERVATION_SEGMENT_SUFFIX = ".observations.json.gz"
MAX_FRAME_TIMESTAMP_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_COMPRESSED_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_OBSERVATION_SEGMENT_BYTES = 64 * 1024 * 1024
FFMPEG_VERSION_OUTPUT_BYTES = 16 * 1024


class ArtifactConflictError(RuntimeError):
    """An immutable output identifier has already been published."""


class InvalidArtifactError(RuntimeError):
    """A referenced local artifact does not match its immutable descriptor."""


@dataclass(frozen=True)
class _PublishedArtifact:
    path: Path
    byte_count: int
    checksum: str


class RaceWindowPreparationService:
    def __init__(self, settings: ServiceSettings) -> None:
        self.settings = settings

    def prepare(self, request: PrepareStageRequest) -> PrepareStageResponse:
        try:
            return self._prepare(request)
        except (
            ArtifactConflictError,
            MediaValidationError,
            OSError,
            ProcessOutputLimitError,
            ProcessTimeoutError,
            ValidationError,
            ValueError,
        ) as error:
            return _rejected(request, _preparation_error_code(error))

    def _prepare(self, request: PrepareStageRequest) -> PrepareStageAccepted:
        self.settings.prepare_roots()
        with claim_staged_media(request, self.settings) as source_path:
            source_bytes, source_checksum, metadata = inspect_and_probe_media(
                source_path,
                expected_byte_count=request.input.expected_byte_count,
                settings=self.settings,
            )
            _validate_window(request.window, metadata)
            ffmpeg_version = _ffmpeg_version(self.settings)
            with tempfile.TemporaryDirectory(
                prefix="prepare-", dir=self.settings.work_root
            ) as raw_work_directory:
                work_directory = Path(raw_work_directory)
                prepared_path = work_directory / "prepared.mp4"
                _prepare_track_view(
                    source_path,
                    prepared_path,
                    request.window,
                    metadata,
                    self.settings,
                )
                frames = _prepared_frames(
                    prepared_path,
                    request.window,
                    metadata.average_frame_rate,
                    self.settings,
                )
                preparation_digest = _preparation_digest(
                    source_checksum=source_checksum,
                    window=request.window,
                    pipeline_version=request.pipeline_version,
                    ffmpeg_version=ffmpeg_version,
                )
                media_checksum, media_bytes = _file_digest(
                    prepared_path,
                    max_bytes=self.settings.limits.max_bytes,
                )
                width = metadata.width
                height = metadata.height * 2 // 3
                manifest = PreparedFrameManifest(
                    contractVersion=PROCESSING_CONTRACT_VERSION,
                    preparedMediaId=request.prepared_media_id,
                    sourceChecksumSha256=source_checksum,
                    sourceByteCount=source_bytes,
                    window=request.window,
                    trackView=_track_view(),
                    mediaByteCount=media_bytes,
                    mediaChecksumSha256=media_checksum,
                    width=width,
                    height=height,
                    averageFrameRate=_rational(metadata.average_frame_rate),
                    ffmpegVersion=ffmpeg_version,
                    pipelineVersion=request.pipeline_version,
                    preparationConfigurationDigest=preparation_digest,
                    frames=frames,
                )
                manifest_bytes = _compressed_contract(manifest)
                media_target = _artifact_path(
                    self.settings,
                    request.prepared_media_id,
                    PREPARED_MEDIA_SUFFIX,
                )
                manifest_target = _artifact_path(
                    self.settings,
                    request.prepared_media_id,
                    FRAME_MANIFEST_SUFFIX,
                )
                published_media = _publish_file(prepared_path, media_target)
                try:
                    published_manifest = _publish_bytes(
                        manifest_bytes,
                        manifest_target,
                    )
                except Exception:
                    _remove_published(published_media)
                    raise

        prepared = PreparedMediaArtifact(
            preparedMediaId=request.prepared_media_id,
            byteCount=published_media.byte_count,
            checksumSha256=published_media.checksum,
            frameManifestByteCount=published_manifest.byte_count,
            frameManifestChecksumSha256=published_manifest.checksum,
            sourceByteCount=source_bytes,
            sourceChecksumSha256=source_checksum,
            window=request.window,
            trackView=_track_view(),
            width=width,
            height=height,
            decodedFrameCount=len(frames),
            averageFrameRate=_rational(metadata.average_frame_rate),
            ffmpegVersion=ffmpeg_version,
            pipelineVersion=request.pipeline_version,
            preparationConfigurationDigest=preparation_digest,
        )
        return PrepareStageAccepted(
            contractVersion=PROCESSING_CONTRACT_VERSION,
            correlationId=request.correlation_id,
            outcome="accepted",
            caseId=request.case_id,
            prepared=prepared,
        )


class SubjectTrackingService:
    def __init__(
        self,
        settings: ServiceSettings,
        provider: InferenceProvider,
    ) -> None:
        self.settings = settings
        self.provider = provider

    def track(self, request: TrackStageRequest) -> TrackStageResponse:
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
            return _rejected(request, _tracking_error_code(error))

    def _track(self, request: TrackStageRequest) -> TrackStageAccepted:
        self.settings.prepare_roots()
        if not self.provider.ready():
            raise InferenceUnavailableError
        provenance = self.provider.provenance
        with tempfile.TemporaryDirectory(
            prefix="track-", dir=self.settings.work_root
        ) as raw_work_directory:
            work_directory = Path(raw_work_directory)
            prepared_path = work_directory / "prepared.mp4"
            _copy_verified_artifact(
                _artifact_path(
                    self.settings,
                    request.prepared.prepared_media_id,
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
            )
            if len(frame_paths) != len(manifest.frames):
                raise InvalidArtifactError
            seed_position = _seed_position(request, manifest)
            observations, gap = self._observe(
                request,
                manifest,
                frame_paths,
                seed_position,
            )

        envelope = AcceptedSubjectObservations(
            contractVersion="subject-observation.v1",
            outcome="accepted",
            caseId=request.case_id,
            observations=observations,
            gaps=() if gap is None else (gap,),
        )
        segment_bytes = _compressed_contract(envelope)
        if len(segment_bytes) > MAX_OBSERVATION_SEGMENT_BYTES:
            raise ProcessOutputLimitError
        published = _publish_bytes(
            segment_bytes,
            _artifact_path(
                self.settings,
                request.observation_segment_id,
                OBSERVATION_SEGMENT_SUFFIX,
            ),
        )
        segment = ObservationSegmentArtifact(
            observationSegmentId=request.observation_segment_id,
            byteCount=published.byte_count,
            checksumSha256=published.checksum,
            contentEncoding="gzip",
            mediaType="application/vnd.rc-mech.subject-observations+json",
            observationCount=len(observations),
            completed=gap is None,
            gap=gap,
            provenance=provenance,
            ffmpegVersion=request.prepared.ffmpeg_version,
            sourceChecksumSha256=request.prepared.source_checksum_sha256,
            preparedChecksumSha256=request.prepared.checksum_sha256,
            preparationConfigurationDigest=(
                request.prepared.preparation_configuration_digest
            ),
        )
        return TrackStageAccepted(
            contractVersion=PROCESSING_CONTRACT_VERSION,
            correlationId=request.correlation_id,
            outcome="accepted",
            caseId=request.case_id,
            segment=segment,
        )

    def _observe(
        self,
        request: TrackStageRequest,
        manifest: PreparedFrameManifest,
        frame_paths: tuple[Path, ...],
        seed_position: int,
    ) -> tuple[tuple[SubjectObservation, ...], TrackingGap | None]:
        observations: list[SubjectObservation] = []
        previous_box: NormalizedBox | None = None
        gap: TrackingGap | None = None
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
            )
            box = _trusted_box(candidate, threshold)
            if box is None:
                if not observations:
                    raise InferenceFailureError
                gap = TrackingGap(
                    startTimestampMs=frame_provenance.timestamp_ms,
                    endTimestampMs=manifest.window.end_timestamp_ms,
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


def _validate_window(window: RaceWindow, metadata: ProbeMetadata) -> None:
    if window.end_timestamp_ms > metadata.duration_ms:
        raise ValueError("Race window exceeds the recording duration")


def _prepare_track_view(
    source: Path,
    destination: Path,
    window: RaceWindow,
    metadata: ProbeMetadata,
    settings: ServiceSettings,
) -> None:
    duration_ms = window.end_timestamp_ms - window.start_timestamp_ms
    arguments = (
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
        str(source),
        "-ss",
        _seconds(window.start_timestamp_ms),
        "-t",
        _seconds(duration_ms),
        "-map",
        f"0:{metadata.video_stream_index}",
        "-vf",
        "crop=iw:2*ih/3:0:ih/3,setsar=1",
        "-an",
        "-sn",
        "-dn",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-vsync",
        "0",
        "-movflags",
        "+faststart",
        str(destination),
    )
    result = run_bounded_process(
        settings.ffmpeg_executable,
        arguments,
        timeout_seconds=settings.limits.process_timeout_seconds,
        max_output_bytes=settings.limits.max_process_output_bytes,
    )
    if result.return_code != 0 or not destination.is_file():
        raise ValueError("Race window preparation failed")


def _prepared_frames(
    prepared_path: Path,
    window: RaceWindow,
    frame_rate: Fraction,
    settings: ServiceSettings,
) -> tuple[PreparedFrame, ...]:
    output_limit = min(
        MAX_FRAME_TIMESTAMP_OUTPUT_BYTES,
        max(settings.limits.max_process_output_bytes, settings.limits.max_frames * 32),
    )
    result = run_bounded_process(
        settings.ffprobe_executable,
        (
            "-hide_banner",
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            ",".join(settings.limits.supported_demuxers),
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "csv=p=0",
            str(prepared_path),
        ),
        timeout_seconds=settings.limits.process_timeout_seconds,
        max_output_bytes=output_limit,
    )
    if result.return_code != 0:
        raise ValueError("Prepared media timestamps are unavailable")
    try:
        lines = result.stdout.decode("utf-8", errors="strict").splitlines()
        timestamps = tuple(
            window.start_timestamp_ms
            + int(
                (Decimal(line.rstrip(",")) * 1000).to_integral_value(
                    rounding=ROUND_HALF_UP
                )
            )
            for line in lines
            if line
        )
    except (UnicodeDecodeError, InvalidOperation, ValueError) as error:
        raise ValueError("Prepared media timestamps are invalid") from error
    if not timestamps or len(timestamps) > settings.limits.max_frames:
        raise ValueError("Prepared media frame count is invalid")
    return tuple(
        PreparedFrame(
            preparedFrameIndex=index,
            frameIndex=_source_frame_index(timestamp_ms, frame_rate),
            timestampMs=timestamp_ms,
        )
        for index, timestamp_ms in enumerate(timestamps)
    )


def _extract_frames(
    prepared_path: Path,
    frame_directory: Path,
    settings: ServiceSettings,
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
        timeout_seconds=settings.limits.process_timeout_seconds,
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
    raw = _read_verified_artifact(
        _artifact_path(
            settings,
            request.prepared.prepared_media_id,
            FRAME_MANIFEST_SUFFIX,
        ),
        expected_bytes=request.prepared.frame_manifest_byte_count,
        expected_checksum=request.prepared.frame_manifest_checksum_sha256,
        max_bytes=MAX_COMPRESSED_MANIFEST_BYTES,
    )
    try:
        with gzip.GzipFile(fileobj=_bytes_reader(raw)) as compressed:
            decompressed = compressed.read(MAX_MANIFEST_BYTES + 1)
    except (EOFError, gzip.BadGzipFile) as error:
        raise InvalidArtifactError from error
    if len(decompressed) > MAX_MANIFEST_BYTES:
        raise InvalidArtifactError
    try:
        manifest = PreparedFrameManifest.model_validate_json(decompressed)
    except ValidationError as error:
        raise InvalidArtifactError from error
    if not _manifest_matches_descriptor(manifest, request.prepared):
        raise InvalidArtifactError
    return manifest


def _manifest_matches_descriptor(
    manifest: PreparedFrameManifest,
    descriptor: PreparedMediaArtifact,
) -> bool:
    manifest_descriptor = (
        manifest.prepared_media_id,
        manifest.source_checksum_sha256,
        manifest.source_byte_count,
        manifest.window,
        manifest.track_view,
        manifest.media_byte_count,
        manifest.media_checksum_sha256,
        manifest.width,
        manifest.height,
        len(manifest.frames),
        manifest.average_frame_rate,
        manifest.ffmpeg_version,
        manifest.pipeline_version,
        manifest.preparation_configuration_digest,
    )
    expected_descriptor = (
        descriptor.prepared_media_id,
        descriptor.source_checksum_sha256,
        descriptor.source_byte_count,
        descriptor.window,
        descriptor.track_view,
        descriptor.byte_count,
        descriptor.checksum_sha256,
        descriptor.width,
        descriptor.height,
        descriptor.decoded_frame_count,
        descriptor.average_frame_rate,
        descriptor.ffmpeg_version,
        descriptor.pipeline_version,
        descriptor.preparation_configuration_digest,
    )
    return manifest_descriptor == expected_descriptor


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


def _track_view() -> FixedTrackView:
    return FixedTrackView(
        x=0.0,
        y=TRACK_VIEW_Y,
        width=1.0,
        height=TRACK_VIEW_HEIGHT,
    )


def _seconds(milliseconds: int) -> str:
    return f"{milliseconds / 1000:.3f}"


def _source_frame_index(timestamp_ms: int, frame_rate: Fraction) -> int:
    value = Fraction(timestamp_ms, 1000) * frame_rate
    return (value.numerator * 2 + value.denominator) // (2 * value.denominator)


def _rational(value: Fraction) -> RationalValue:
    return RationalValue(numerator=value.numerator, denominator=value.denominator)


def _ffmpeg_version(settings: ServiceSettings) -> str:
    result = run_bounded_process(
        settings.ffmpeg_executable,
        ("-version",),
        timeout_seconds=settings.limits.process_timeout_seconds,
        max_output_bytes=FFMPEG_VERSION_OUTPUT_BYTES,
    )
    if result.return_code != 0:
        raise ValueError("FFmpeg version is unavailable")
    try:
        first_line = result.stdout.decode("utf-8", errors="strict").splitlines()[0]
        prefix, version, *_rest = first_line.split()
    except (IndexError, UnicodeDecodeError, ValueError) as error:
        raise ValueError("FFmpeg version is invalid") from error
    if prefix != "ffmpeg" or version != "version" or not _rest:
        raise ValueError("FFmpeg version is invalid")
    return _rest[0]


def _preparation_digest(
    *,
    source_checksum: str,
    window: RaceWindow,
    pipeline_version: str,
    ffmpeg_version: str,
) -> str:
    payload = {
        "ffmpegVersion": ffmpeg_version,
        "pipelineVersion": pipeline_version,
        "sourceChecksumSha256": source_checksum,
        "trackView": _track_view().model_dump(mode="json", by_alias=True),
        "window": window.model_dump(mode="json", by_alias=True),
    }
    return hashlib.sha256(_canonical_json(payload)).hexdigest()


def _compressed_contract(contract: BaseModel) -> bytes:
    payload = contract.model_dump(mode="json", by_alias=True)
    return gzip.compress(_canonical_json(payload), compresslevel=9, mtime=0)


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(
            value,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode()


def _bytes_reader(value: bytes) -> BinaryIO:
    return io.BytesIO(value)


def _artifact_path(settings: ServiceSettings, artifact_id: str, suffix: str) -> Path:
    return settings.artifact_root / f"{artifact_id}{suffix}"


def _publish_file(source: Path, destination: Path) -> _PublishedArtifact:
    with source.open("rb") as source_file:
        return _publish_stream(source_file, destination)


def _publish_bytes(value: bytes, destination: Path) -> _PublishedArtifact:
    with tempfile.TemporaryFile() as stream:
        stream.write(value)
        stream.seek(0)
        return _publish_stream(stream, destination)


def _publish_stream(stream: BinaryIO, destination: Path) -> _PublishedArtifact:
    descriptor, pending_name = tempfile.mkstemp(
        prefix=".pending-",
        dir=destination.parent,
    )
    pending = Path(pending_name)
    digest = hashlib.sha256()
    byte_count = 0
    try:
        os.fchmod(descriptor, 0o600)
        while chunk := stream.read(1024 * 1024):
            byte_count += len(chunk)
            digest.update(chunk)
            _write_all(descriptor, chunk)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        try:
            os.link(pending, destination)
        except FileExistsError as error:
            raise ArtifactConflictError from error
        return _PublishedArtifact(destination, byte_count, digest.hexdigest())
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        pending.unlink(missing_ok=True)


def _remove_published(artifact: _PublishedArtifact) -> None:
    try:
        identity = artifact.path.stat(follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISREG(identity.st_mode):
        artifact.path.unlink()


def _read_verified_artifact(
    source: Path,
    *,
    expected_bytes: int,
    expected_checksum: str,
    max_bytes: int,
) -> bytes:
    descriptor = _open_artifact(source)
    digest = hashlib.sha256()
    result = bytearray()
    try:
        while chunk := os.read(descriptor, 1024 * 1024):
            result.extend(chunk)
            digest.update(chunk)
            if len(result) > max_bytes:
                raise InvalidArtifactError
    finally:
        os.close(descriptor)
    if len(result) != expected_bytes or digest.hexdigest() != expected_checksum:
        raise InvalidArtifactError
    return bytes(result)


def _copy_verified_artifact(
    source: Path,
    destination: Path,
    *,
    expected_bytes: int,
    expected_checksum: str,
    max_bytes: int,
) -> None:
    descriptor = _open_artifact(source)
    destination_descriptor = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    digest = hashlib.sha256()
    byte_count = 0
    try:
        while chunk := os.read(descriptor, 1024 * 1024):
            byte_count += len(chunk)
            if byte_count > max_bytes:
                raise InvalidArtifactError
            digest.update(chunk)
            _write_all(destination_descriptor, chunk)
        os.fsync(destination_descriptor)
    finally:
        os.close(descriptor)
        os.close(destination_descriptor)
    if byte_count != expected_bytes or digest.hexdigest() != expected_checksum:
        destination.unlink(missing_ok=True)
        raise InvalidArtifactError


def _open_artifact(path: Path) -> int:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as error:
        raise InvalidArtifactError from error
    identity = os.fstat(descriptor)
    if not stat.S_ISREG(identity.st_mode):
        os.close(descriptor)
        raise InvalidArtifactError
    return descriptor


def _file_digest(path: Path, *, max_bytes: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    byte_count = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            byte_count += len(chunk)
            if byte_count > max_bytes:
                raise ValueError("Prepared artifact exceeds its byte limit")
            digest.update(chunk)
    if byte_count == 0:
        raise ValueError("Prepared artifact is empty")
    return digest.hexdigest(), byte_count


def _write_all(descriptor: int, value: bytes) -> None:
    remaining = memoryview(value)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise OSError("Unable to write artifact")
        remaining = remaining[written:]


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


def _preparation_error_code(error: Exception) -> ProcessingErrorCode:
    if isinstance(error, ArtifactConflictError):
        return "ARTIFACT_CONFLICT"
    if isinstance(error, ProcessTimeoutError):
        return "PROCESS_TIMEOUT"
    if isinstance(error, MediaValidationError):
        if error.code in {"STAGED_MEDIA_NOT_FOUND", "STAGED_MEDIA_MISMATCH"}:
            return "MEDIA_UNAVAILABLE"
        if error.code == "PROCESS_TIMEOUT":
            return "PROCESS_TIMEOUT"
    return "PREPARATION_FAILED"


def _tracking_error_code(error: Exception) -> ProcessingErrorCode:
    if isinstance(error, ArtifactConflictError):
        return "ARTIFACT_CONFLICT"
    if isinstance(error, InferenceUnavailableError):
        return "INFERENCE_UNAVAILABLE"
    if isinstance(error, InvalidArtifactError):
        return "MEDIA_UNAVAILABLE"
    if isinstance(error, ProcessTimeoutError):
        return "PROCESS_TIMEOUT"
    if isinstance(error, ProcessOutputLimitError):
        return "RESOURCE_LIMIT"
    return "INFERENCE_FAILED"


def _rejected(
    request: PrepareStageRequest | TrackStageRequest,
    code: ProcessingErrorCode,
) -> ProcessingRejected:
    error_values: dict[ProcessingErrorCode, tuple[str, str]] = {
        "INVALID_REQUEST": ("request", "processing request rejected"),
        "MEDIA_UNAVAILABLE": ("prepare", "processing media unavailable"),
        "PREPARATION_FAILED": (
            "prepare",
            "Race window preparation failed safely",
        ),
        "PROCESS_TIMEOUT": (
            "track" if isinstance(request, TrackStageRequest) else "prepare",
            "processing exceeded its time limit",
        ),
        "INFERENCE_UNAVAILABLE": (
            "initialize",
            "inference provider unavailable",
        ),
        "INFERENCE_FAILED": ("track", "inference failed safely"),
        "RESOURCE_LIMIT": (
            "serialize",
            "processing resource limit exceeded",
        ),
        "ARTIFACT_CONFLICT": (
            "serialize",
            "immutable artifact already exists",
        ),
    }
    stage, message = error_values[code]
    return ProcessingRejected.model_validate(
        {
            "contractVersion": PROCESSING_CONTRACT_VERSION,
            "correlationId": request.correlation_id,
            "outcome": "rejected",
            "caseId": request.case_id,
            "error": {"code": code, "stage": stage, "message": message},
        }
    )
