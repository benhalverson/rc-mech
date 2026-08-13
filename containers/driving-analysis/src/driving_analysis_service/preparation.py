# Internal media validation and process details are mapped to canonical safe
# errors before leaving this module.
# ruff: noqa: EM101, TRY003

import hashlib
import tempfile
import threading
import time
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from fractions import Fraction
from itertools import pairwise
from pathlib import Path

from pydantic import ValidationError

from driving_analysis_service.contracts import RationalValue
from driving_analysis_service.errors import MediaValidationError
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
from driving_analysis_service.processing_errors import preparation_error_code, rejected
from driving_analysis_service.settings import ServiceSettings
from driving_analysis_service.tracking_artifacts import (
    FRAME_MANIFEST_SUFFIX,
    MAX_COMPRESSED_MANIFEST_BYTES,
    PREPARED_BUNDLE_SUFFIX,
    PREPARED_COMPLETION_SUFFIX,
    PREPARED_MEDIA_SUFFIX,
    ArtifactConflictError,
    InvalidArtifactError,
    bundle_member_path,
    bundle_path,
    canonical_json,
    compressed_contract,
    file_digest,
    publish_bundle,
    read_completion,
    read_verified_artifact,
)
from driving_analysis_service.tracking_contracts import (
    PROCESSING_CONTRACT_VERSION,
    TRACK_VIEW_HEIGHT,
    TRACK_VIEW_Y,
    FixedTrackView,
    PreparedFrame,
    PreparedFrameManifest,
    PreparedMediaArtifact,
    PrepareStageAccepted,
    PrepareStageRequest,
    PrepareStageResponse,
    RaceWindow,
)

MAX_FRAME_TIMESTAMP_OUTPUT_BYTES = 64 * 1024 * 1024
FFMPEG_VERSION_OUTPUT_BYTES = 16 * 1024
MAX_COMPLETION_BYTES = 64 * 1024


@dataclass(frozen=True)
class _PreparedMemberNames:
    media: str
    manifest: str
    completion: str


class RaceWindowPreparationService:
    def __init__(
        self,
        settings: ServiceSettings,
        admission: threading.BoundedSemaphore | None = None,
    ) -> None:
        self.settings = settings
        self._admission = admission or threading.BoundedSemaphore(
            settings.limits.max_concurrent_processing
        )

    def prepare(self, request: PrepareStageRequest) -> PrepareStageResponse:
        if not self._admission.acquire(blocking=False):
            return rejected(request, "RESOURCE_LIMIT")
        try:
            return self._prepare(request)
        except (
            ArtifactConflictError,
            InvalidArtifactError,
            MediaValidationError,
            OSError,
            ProcessOutputLimitError,
            ProcessTimeoutError,
            ValidationError,
            ValueError,
        ) as error:
            return rejected(request, preparation_error_code(error))
        finally:
            self._admission.release()

    def _prepare(self, request: PrepareStageRequest) -> PrepareStageAccepted:
        self.settings.prepare_roots()
        recovered = _recover_completed_preparation(request, self.settings)
        if recovered is not None:
            return _accepted(request, recovered)

        deadline = time.monotonic() + self.settings.limits.process_timeout_seconds
        with claim_staged_media(request, self.settings) as source_path:
            source_bytes, source_checksum, metadata = inspect_and_probe_media(
                source_path,
                expected_byte_count=request.input.expected_byte_count,
                settings=self.settings,
            )
            _validate_window(request.window, metadata, self.settings)
            frames = _source_frames(
                source_path,
                request.window,
                metadata,
                self.settings,
                deadline,
            )
            ffmpeg_version = _ffmpeg_version(self.settings, deadline)
            with tempfile.TemporaryDirectory(
                prefix="prepare-", dir=self.settings.work_root
            ) as raw_work_directory:
                prepared_path = Path(raw_work_directory) / "prepared.mp4"
                _prepare_track_view(
                    source_path,
                    prepared_path,
                    request.window,
                    metadata,
                    self.settings,
                    deadline,
                )
                if _prepared_frame_count(
                    prepared_path,
                    self.settings,
                    deadline,
                ) != len(frames):
                    raise ValueError("Prepared media does not preserve source frames")
                preparation_digest = _preparation_digest(
                    source_checksum=source_checksum,
                    window=request.window,
                    pipeline_version=request.pipeline_version,
                    ffmpeg_version=ffmpeg_version,
                )
                media_checksum, media_bytes = file_digest(
                    prepared_path,
                    max_bytes=self.settings.limits.max_bytes,
                )
                width = metadata.width
                height = metadata.height * 2 // 3
                manifest = PreparedFrameManifest(
                    contractVersion=PROCESSING_CONTRACT_VERSION,
                    preparedMediaId=request.prepared_media_id,
                    caseId=request.case_id,
                    sourceChecksumSha256=source_checksum,
                    sourceByteCount=source_bytes,
                    window=request.window,
                    trackView=track_view(),
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
                manifest_bytes = compressed_contract(manifest)
                prepared = PreparedMediaArtifact(
                    preparedMediaId=request.prepared_media_id,
                    caseId=request.case_id,
                    byteCount=media_bytes,
                    checksumSha256=media_checksum,
                    frameManifestByteCount=len(manifest_bytes),
                    frameManifestChecksumSha256=hashlib.sha256(
                        manifest_bytes
                    ).hexdigest(),
                    sourceByteCount=source_bytes,
                    sourceChecksumSha256=source_checksum,
                    window=request.window,
                    trackView=track_view(),
                    width=width,
                    height=height,
                    decodedFrameCount=len(frames),
                    averageFrameRate=_rational(metadata.average_frame_rate),
                    ffmpegVersion=ffmpeg_version,
                    pipelineVersion=request.pipeline_version,
                    preparationConfigurationDigest=preparation_digest,
                )
                names = _prepared_member_names(request.prepared_media_id)
                created = publish_bundle(
                    bundle_path(
                        self.settings,
                        request.prepared_media_id,
                        PREPARED_BUNDLE_SUFFIX,
                    ),
                    {
                        names.media: prepared_path,
                        names.manifest: manifest_bytes,
                        names.completion: canonical_json(
                            prepared.model_dump(mode="json", by_alias=True)
                        ),
                    },
                )
                if not created:
                    recovered = _recover_completed_preparation(
                        request,
                        self.settings,
                    )
                    if recovered != prepared:
                        raise ArtifactConflictError
                    prepared = recovered
        return _accepted(request, prepared)


def _recover_completed_preparation(
    request: PrepareStageRequest,
    settings: ServiceSettings,
) -> PreparedMediaArtifact | None:
    bundle = bundle_path(settings, request.prepared_media_id, PREPARED_BUNDLE_SUFFIX)
    if not bundle.exists():
        return None
    completed = read_completion(
        bundle_member_path(
            settings,
            request.prepared_media_id,
            PREPARED_BUNDLE_SUFFIX,
            PREPARED_COMPLETION_SUFFIX,
        ),
        PreparedMediaArtifact,
        max_bytes=MAX_COMPLETION_BYTES,
    )
    if completed is None:
        return None
    if (
        completed.prepared_media_id != request.prepared_media_id
        or completed.case_id != request.case_id
        or completed.source_byte_count != request.input.expected_byte_count
        or completed.window != request.window
        or completed.pipeline_version != request.pipeline_version
    ):
        raise ArtifactConflictError
    media_checksum, media_bytes = file_digest(
        bundle_member_path(
            settings,
            request.prepared_media_id,
            PREPARED_BUNDLE_SUFFIX,
            PREPARED_MEDIA_SUFFIX,
        ),
        max_bytes=settings.limits.max_bytes,
    )
    if (media_bytes, media_checksum) != (
        completed.byte_count,
        completed.checksum_sha256,
    ):
        raise InvalidArtifactError
    read_verified_artifact(
        bundle_member_path(
            settings,
            request.prepared_media_id,
            PREPARED_BUNDLE_SUFFIX,
            FRAME_MANIFEST_SUFFIX,
        ),
        expected_bytes=completed.frame_manifest_byte_count,
        expected_checksum=completed.frame_manifest_checksum_sha256,
        max_bytes=MAX_COMPRESSED_MANIFEST_BYTES,
    )
    return completed


def _prepared_member_names(prepared_media_id: str) -> _PreparedMemberNames:
    return _PreparedMemberNames(
        media=f"{prepared_media_id}{PREPARED_MEDIA_SUFFIX}",
        manifest=f"{prepared_media_id}{FRAME_MANIFEST_SUFFIX}",
        completion=f"{prepared_media_id}{PREPARED_COMPLETION_SUFFIX}",
    )


def _accepted(
    request: PrepareStageRequest,
    prepared: PreparedMediaArtifact,
) -> PrepareStageAccepted:
    return PrepareStageAccepted(
        contractVersion=PROCESSING_CONTRACT_VERSION,
        correlationId=request.correlation_id,
        outcome="accepted",
        caseId=request.case_id,
        prepared=prepared,
    )


def _validate_window(
    window: RaceWindow,
    metadata: ProbeMetadata,
    settings: ServiceSettings,
) -> None:
    if window.end_timestamp_ms > metadata.duration_ms:
        raise ValueError("Race window exceeds the recording duration")
    if (
        window.end_timestamp_ms - window.start_timestamp_ms
        > settings.limits.max_race_window_ms
    ):
        raise ProcessOutputLimitError


def _source_frames(
    source: Path,
    window: RaceWindow,
    metadata: ProbeMetadata,
    settings: ServiceSettings,
    deadline: float,
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
            str(metadata.video_stream_index),
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "csv=p=0",
            str(source),
        ),
        timeout_seconds=_remaining_seconds(deadline),
        max_output_bytes=output_limit,
    )
    if result.return_code != 0:
        raise ValueError("Source frame provenance is unavailable")
    try:
        timestamps = tuple(
            (
                source_index,
                int(
                    (Decimal(line.rstrip(",")) * 1000).to_integral_value(
                        rounding=ROUND_HALF_UP
                    )
                )
                - metadata.start_time_ms,
            )
            for source_index, line in enumerate(
                line
                for line in result.stdout.decode("utf-8", errors="strict").splitlines()
                if line
            )
        )
    except (UnicodeDecodeError, InvalidOperation, ValueError) as error:
        raise ValueError("Source frame provenance is invalid") from error
    selected = tuple(
        PreparedFrame(
            preparedFrameIndex=prepared_index,
            frameIndex=source_index,
            timestampMs=timestamp_ms,
        )
        for prepared_index, (source_index, timestamp_ms) in enumerate(
            item
            for item in timestamps
            if window.start_timestamp_ms <= item[1] < window.end_timestamp_ms
        )
    )
    if not selected or len(selected) > settings.limits.max_frames:
        raise ValueError("Race window source frame count is invalid")
    if any(
        current.frame_index <= previous.frame_index
        or current.timestamp_ms <= previous.timestamp_ms
        for previous, current in pairwise(selected)
    ):
        raise ValueError("Race window source frame provenance is not ordered")
    return selected


def _prepare_track_view(  # noqa: PLR0913 - bounded process inputs stay explicit
    source: Path,
    destination: Path,
    window: RaceWindow,
    metadata: ProbeMetadata,
    settings: ServiceSettings,
    deadline: float,
) -> None:
    source_start_ms = metadata.start_time_ms + window.start_timestamp_ms
    source_end_ms = metadata.start_time_ms + window.end_timestamp_ms
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
            str(source),
            "-map",
            f"0:{metadata.video_stream_index}",
            "-vf",
            (
                f"trim=start={_seconds(source_start_ms)}:end={_seconds(source_end_ms)},"
                "crop=iw:2*ih/3:0:ih/3,setpts=PTS-STARTPTS,setsar=1"
            ),
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
        ),
        timeout_seconds=_remaining_seconds(deadline),
        max_output_bytes=settings.limits.max_process_output_bytes,
    )
    if result.return_code != 0 or not destination.is_file():
        raise ValueError("Race window preparation failed")


def _prepared_frame_count(
    prepared_path: Path,
    settings: ServiceSettings,
    deadline: float,
) -> int:
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
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "csv=p=0",
            str(prepared_path),
        ),
        timeout_seconds=_remaining_seconds(deadline),
        max_output_bytes=settings.limits.max_process_output_bytes,
    )
    if result.return_code != 0:
        raise ValueError("Prepared media frame count is unavailable")
    try:
        return int(result.stdout.decode("ascii", errors="strict").strip())
    except (UnicodeDecodeError, ValueError) as error:
        raise ValueError("Prepared media frame count is invalid") from error


def track_view() -> FixedTrackView:
    return FixedTrackView(x=0.0, y=TRACK_VIEW_Y, width=1.0, height=TRACK_VIEW_HEIGHT)


def _seconds(milliseconds: int) -> str:
    return f"{milliseconds / 1000:.3f}"


def _rational(value: Fraction) -> RationalValue:
    return RationalValue(numerator=value.numerator, denominator=value.denominator)


def _ffmpeg_version(settings: ServiceSettings, deadline: float) -> str:
    result = run_bounded_process(
        settings.ffmpeg_executable,
        ("-version",),
        timeout_seconds=_remaining_seconds(deadline),
        max_output_bytes=FFMPEG_VERSION_OUTPUT_BYTES,
    )
    if result.return_code != 0:
        raise ValueError("FFmpeg version is unavailable")
    try:
        first_line = result.stdout.decode("utf-8", errors="strict").splitlines()[0]
        prefix, version, *rest = first_line.split()
    except (IndexError, UnicodeDecodeError, ValueError) as error:
        raise ValueError("FFmpeg version is invalid") from error
    if prefix != "ffmpeg" or version != "version" or not rest:
        raise ValueError("FFmpeg version is invalid")
    return rest[0]


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
        "trackView": track_view().model_dump(mode="json", by_alias=True),
        "window": window.model_dump(mode="json", by_alias=True),
    }
    return hashlib.sha256(canonical_json(payload)).hexdigest()


def _remaining_seconds(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProcessTimeoutError
    return remaining
