import hashlib
import json
import math
import os
import re
import shutil
import stat
import tempfile
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from fractions import Fraction
from pathlib import Path
from typing import cast

from driving_analysis_service.contracts import (
    CONTRACT_VERSION,
    AcceptedValidationResponse,
    ErrorStage,
    MediaFacts,
    MediaValidationRequest,
    RationalValue,
    RejectedValidationResponse,
    SafeError,
    ValidationResponse,
)
from driving_analysis_service.errors import MediaValidationError
from driving_analysis_service.processes import (
    ProcessOutputLimitError,
    ProcessTimeoutError,
    StderrLineObserver,
    run_bounded_process,
)
from driving_analysis_service.safe_logging import log_stage
from driving_analysis_service.settings import ServiceSettings

JsonMapping = Mapping[str, object]
MAX_METADATA_ITEMS = 8
MAX_IDENTIFIER_LENGTH = 32
MAX_SHOWINFO_LINE_BYTES = 16 * 1024
SHOWINFO_FRAME_PATTERN = re.compile(
    rb"\bn:\s*\d+\b.*\bsar:(\d+)/(\d+)\s+s:(\d+)x(\d+)\b"
)
SHOWINFO_ROTATION_PATTERN = re.compile(
    rb"\bside data - displaymatrix: rotation of (-?\d+(?:\.\d+)?) degrees\s*$"
)


@dataclass(frozen=True)
class ProbeMetadata:
    duration_ms: int
    width: int
    height: int
    video_stream_index: int
    video_codec: str
    audio_codecs: tuple[str, ...]
    container_formats: tuple[str, ...]
    average_frame_rate: Fraction
    time_base: Fraction
    sample_aspect_ratio: Fraction
    display_aspect_ratio: Fraction
    start_time_ms: int


class _DecodedLayoutObserver:
    def __init__(self, metadata: ProbeMetadata, max_frames: int) -> None:
        self.metadata = metadata
        self.max_frames = max_frames
        self.frame_count = 0

    def __call__(self, line: bytes) -> bool:
        if not line.startswith(b"[Parsed_showinfo_"):
            return False
        if b"side data - displaymatrix:" in line:
            match = SHOWINFO_ROTATION_PATTERN.search(line)
            if match is None:
                raise _invalid_decode_output()
            rotation = Fraction(match.group(1).decode("ascii"))
            if rotation % 360 != 0:
                raise _incompatible_decoded_layout()
            return True
        if b" n:" not in line:
            return True
        match = SHOWINFO_FRAME_PATTERN.search(line)
        if match is None:
            raise _invalid_decode_output()
        sar_numerator, sar_denominator, width, height = (
            int(value) for value in match.groups()
        )
        try:
            sample_aspect_ratio = Fraction(sar_numerator, sar_denominator)
        except ZeroDivisionError as error:
            raise _invalid_decode_output() from error
        self.frame_count += 1
        if self.frame_count > self.max_frames:
            raise MediaValidationError(
                code="MEDIA_OVER_LIMIT",
                stage="decode",
                safe_message="The decoded frame count exceeds the configured limit.",
            )
        if (
            width != self.metadata.width
            or height != self.metadata.height
            or sample_aspect_ratio != self.metadata.sample_aspect_ratio
        ):
            raise _incompatible_decoded_layout()
        return True


class MediaValidationService:
    def __init__(self, settings: ServiceSettings) -> None:
        self.settings = settings
        self._admission = threading.BoundedSemaphore(
            settings.limits.max_concurrent_validations
        )

    def validate(self, request: MediaValidationRequest) -> ValidationResponse:
        if not self._admission.acquire(blocking=False):
            log_stage(
                correlation_id=request.correlation_id,
                stage="admission",
                elapsed_ms=0,
                outcome="SERVICE_BUSY",
            )
            return RejectedValidationResponse(
                contractVersion=CONTRACT_VERSION,
                correlationId=request.correlation_id,
                outcome="rejected",
                error=SafeError(
                    code="SERVICE_BUSY",
                    stage="admission",
                    message="The media validation service is busy.",
                ),
            )
        try:
            return self._validate_admitted(request)
        finally:
            self._admission.release()

    def _validate_admitted(
        self,
        request: MediaValidationRequest,
    ) -> ValidationResponse:
        started_at = time.monotonic()
        stage: ErrorStage = "claim"
        try:
            self.settings.prepare_roots()
            with _claimed_media(request, self.settings) as claimed_path:
                stage = "inspect"
                byte_count, checksum = _inspect_file(
                    claimed_path,
                    expected_byte_count=request.input.expected_byte_count,
                    max_bytes=self.settings.limits.max_bytes,
                )
                _reject_indirect_media(claimed_path)
                stage = "probe"
                metadata = _probe_media(claimed_path, self.settings)
                stage = "decode"
                decoded_frame_count = _decode_media(
                    claimed_path,
                    metadata,
                    self.settings,
                )
                media = _media_facts(
                    byte_count=byte_count,
                    checksum=checksum,
                    metadata=metadata,
                    decoded_frame_count=decoded_frame_count,
                )

            _log_result(
                request.correlation_id,
                "complete",
                started_at,
                "accepted",
                media,
            )
            return AcceptedValidationResponse(
                contractVersion=CONTRACT_VERSION,
                correlationId=request.correlation_id,
                outcome="accepted",
                media=media,
            )
        except MediaValidationError as error:
            _log_result(
                request.correlation_id,
                error.stage,
                started_at,
                error.code,
            )
            return RejectedValidationResponse(
                contractVersion=CONTRACT_VERSION,
                correlationId=request.correlation_id,
                outcome="rejected",
                error=error.as_contract(),
            )
        except Exception:  # noqa: BLE001 - provider details must never escape
            _log_result(
                request.correlation_id,
                stage,
                started_at,
                "INTERNAL_ERROR",
            )
            return RejectedValidationResponse(
                contractVersion=CONTRACT_VERSION,
                correlationId=request.correlation_id,
                outcome="rejected",
                error=SafeError(
                    code="INTERNAL_ERROR",
                    stage=stage,
                    message="Media validation failed safely.",
                ),
            )


class _ClaimedMedia:
    def __init__(
        self,
        request: MediaValidationRequest,
        settings: ServiceSettings,
    ) -> None:
        self.source_path = settings.staging_root / (
            f"{request.input.staged_media_id}.media"
        )
        self.work_root = settings.work_root
        self.max_bytes = settings.limits.max_bytes
        self.request_directory: Path | None = None
        self.claimed_path: Path | None = None

    def __enter__(self) -> Path:
        self.request_directory = Path(
            tempfile.mkdtemp(prefix="request-", dir=self.work_root)
        )
        self.claimed_path = self.request_directory / "input.media"
        try:
            _copy_and_consume(
                self.source_path,
                self.claimed_path,
                max_bytes=self.max_bytes,
            )
        except FileNotFoundError as error:
            self._cleanup()
            raise MediaValidationError(
                code="STAGED_MEDIA_NOT_FOUND",
                stage="claim",
                safe_message="The staged media is unavailable.",
            ) from error
        except MediaValidationError:
            self._cleanup()
            raise
        except OSError as error:
            self._cleanup()
            raise MediaValidationError(
                code="INTERNAL_ERROR",
                stage="claim",
                safe_message="The staged media could not be claimed safely.",
            ) from error
        return self.claimed_path

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: object,
    ) -> None:
        self._cleanup()

    def _cleanup(self) -> None:
        if self.request_directory is not None and self.request_directory.exists():
            shutil.rmtree(self.request_directory)


def _claimed_media(
    request: MediaValidationRequest,
    settings: ServiceSettings,
) -> _ClaimedMedia:
    return _ClaimedMedia(request, settings)


def _discard_staged_input(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except IsADirectoryError:
        path.rmdir()


def _copy_and_consume(source: Path, destination: Path, *, max_bytes: int) -> None:
    source_descriptor = _open_staged_source(source)
    destination_descriptor: int | None = None
    source_identity = os.fstat(source_descriptor)
    try:
        if not stat.S_ISREG(source_identity.st_mode):
            raise MediaValidationError(
                code="UNSUPPORTED_MEDIA",
                stage="claim",
                safe_message="The staged input is not a supported media file.",
            )
        destination_descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        copied_bytes = 0
        while chunk := os.read(source_descriptor, 1024 * 1024):
            copied_bytes += len(chunk)
            if copied_bytes > max_bytes:
                raise MediaValidationError(
                    code="MEDIA_OVER_LIMIT",
                    stage="claim",
                    safe_message="The media exceeds the byte limit.",
                )
            _write_all(destination_descriptor, chunk)
        os.fsync(destination_descriptor)
    finally:
        os.close(source_descriptor)
        if destination_descriptor is not None:
            os.close(destination_descriptor)
        _unlink_same_file(source, source_identity.st_dev, source_identity.st_ino)


def _open_staged_source(source: Path) -> int:
    try:
        return os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as error:
        source_identity = source.lstat()
        if stat.S_ISREG(source_identity.st_mode):
            raise
        _unlink_same_file(source, source_identity.st_dev, source_identity.st_ino)
        raise MediaValidationError(
            code="UNSUPPORTED_MEDIA",
            stage="claim",
            safe_message="The staged input is not a supported media file.",
        ) from error


def _write_all(file_descriptor: int, data: bytes) -> None:
    remaining = memoryview(data)
    while remaining:
        written = os.write(file_descriptor, remaining)
        if written <= 0:
            msg = "Unable to copy staged media"
            raise OSError(msg)
        remaining = remaining[written:]


def _unlink_same_file(path: Path, expected_device: int, expected_inode: int) -> None:
    try:
        current_identity = path.lstat()
    except FileNotFoundError:
        return
    if (
        current_identity.st_dev != expected_device
        or current_identity.st_ino != expected_inode
    ):
        msg = "Staged media identity changed while claiming"
        raise OSError(msg)
    _discard_staged_input(path)


def _inspect_file(
    path: Path,
    *,
    expected_byte_count: int,
    max_bytes: int,
) -> tuple[int, str]:
    byte_count = path.stat().st_size
    if byte_count > max_bytes:
        raise MediaValidationError(
            code="MEDIA_OVER_LIMIT",
            stage="inspect",
            safe_message="The media exceeds the byte limit.",
        )
    if byte_count <= 0:
        raise MediaValidationError(
            code="CORRUPT_MEDIA",
            stage="inspect",
            safe_message="The media is empty or corrupt.",
        )
    if byte_count != expected_byte_count:
        raise MediaValidationError(
            code="STAGED_MEDIA_MISMATCH",
            stage="inspect",
            safe_message="The staged media byte count does not match.",
        )
    digest = hashlib.sha256()
    counted_bytes = 0
    with path.open("rb") as media_file:
        while chunk := media_file.read(1024 * 1024):
            counted_bytes += len(chunk)
            if counted_bytes > max_bytes:
                raise MediaValidationError(
                    code="MEDIA_OVER_LIMIT",
                    stage="inspect",
                    safe_message="The media exceeds the byte limit.",
                )
            digest.update(chunk)
    if counted_bytes != byte_count:
        raise MediaValidationError(
            code="STAGED_MEDIA_MISMATCH",
            stage="inspect",
            safe_message="The staged media changed during inspection.",
        )
    return byte_count, digest.hexdigest()


def _reject_indirect_media(path: Path) -> None:
    with path.open("rb") as media_file:
        header = media_file.read(4096).lstrip()
    if header.startswith((b"#EXTM3U", b"ffconcat version")):
        raise MediaValidationError(
            code="UNSUPPORTED_MEDIA",
            stage="inspect",
            safe_message="Indirect media manifests are unsupported.",
        )


def _probe_media(path: Path, settings: ServiceSettings) -> ProbeMetadata:
    arguments = (
        "-hide_banner",
        "-v",
        "error",
        "-print_format",
        "json",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        ",".join(settings.limits.supported_demuxers),
        "-show_format",
        "-show_streams",
        str(path),
    )
    try:
        result = run_bounded_process(
            settings.ffprobe_executable,
            arguments,
            timeout_seconds=settings.limits.process_timeout_seconds,
            max_output_bytes=settings.limits.max_process_output_bytes,
        )
    except ProcessTimeoutError as error:
        raise MediaValidationError(
            code="PROCESS_TIMEOUT",
            stage="probe",
            safe_message="Media probing exceeded its time limit.",
        ) from error
    except ProcessOutputLimitError as error:
        raise MediaValidationError(
            code="MEDIA_OVER_LIMIT",
            stage="probe",
            safe_message="Media probe output exceeded its limit.",
        ) from error

    if result.return_code != 0:
        raise MediaValidationError(
            code="CORRUPT_MEDIA",
            stage="probe",
            safe_message="The media could not be probed.",
        )
    try:
        raw_probe: object = json.loads(result.stdout)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise MediaValidationError(
            code="CORRUPT_MEDIA",
            stage="probe",
            safe_message="The media probe returned invalid metadata.",
        ) from error
    return _parse_probe(raw_probe, settings)


def _parse_probe(raw_probe: object, settings: ServiceSettings) -> ProbeMetadata:
    root = _as_mapping(raw_probe)
    streams, video = _streams_and_video(root)

    video_stream_index = _positive_or_zero_int(video.get("index"))
    width = _positive_int(video.get("width"))
    height = _positive_int(video.get("height"))
    video_codec = _bounded_identifier(video.get("codec_name"))
    if video_codec not in settings.limits.supported_video_codecs:
        raise _unsupported_probe()
    if width > settings.limits.max_width or height > settings.limits.max_height:
        raise MediaValidationError(
            code="MEDIA_OVER_LIMIT",
            stage="probe",
            safe_message="The media dimensions exceed the configured limit.",
        )

    sample_aspect_ratio, display_aspect_ratio = _layout_fractions(video, width, height)

    average_frame_rate = _parse_frame_rate(video)
    time_base = _parse_fraction(video.get("time_base"), delimiters=("/",))
    raw_format = _as_mapping(root.get("format"))
    duration_ms = _duration_ms(video, raw_format)
    if duration_ms > settings.limits.max_duration_ms:
        raise MediaValidationError(
            code="MEDIA_OVER_LIMIT",
            stage="probe",
            safe_message="The media duration exceeds the configured limit.",
        )

    estimated_frames = math.ceil(Fraction(duration_ms, 1000) * average_frame_rate)
    if estimated_frames > settings.limits.max_frames:
        raise MediaValidationError(
            code="MEDIA_OVER_LIMIT",
            stage="probe",
            safe_message="The media frame count exceeds the configured limit.",
        )

    start_time_ms = _milliseconds(
        video.get("start_time", raw_format.get("start_time", "0")),
        allow_negative=True,
    )
    audio_codecs = tuple(
        _bounded_identifier(stream.get("codec_name"))
        for stream in streams
        if stream.get("codec_type") == "audio"
    )
    if len(audio_codecs) > MAX_METADATA_ITEMS:
        raise _unsupported_probe()
    container_formats = tuple(
        item
        for item in (
            _bounded_identifier(part)
            for part in _required_string(raw_format.get("format_name")).split(",")
        )
        if item
    )
    if not container_formats or len(container_formats) > MAX_METADATA_ITEMS:
        raise _unsupported_probe()
    if not set(container_formats).issubset(settings.limits.supported_container_formats):
        raise _unsupported_probe()

    return ProbeMetadata(
        duration_ms=duration_ms,
        width=width,
        height=height,
        video_stream_index=video_stream_index,
        video_codec=video_codec,
        audio_codecs=audio_codecs,
        container_formats=container_formats,
        average_frame_rate=average_frame_rate,
        time_base=time_base,
        sample_aspect_ratio=sample_aspect_ratio,
        display_aspect_ratio=display_aspect_ratio,
        start_time_ms=start_time_ms,
    )


def _streams_and_video(root: JsonMapping) -> tuple[list[JsonMapping], JsonMapping]:
    raw_streams = root.get("streams")
    if not isinstance(raw_streams, list):
        raise _unsupported_probe()
    streams = [_as_mapping(stream) for stream in raw_streams]
    video_streams = [
        stream for stream in streams if stream.get("codec_type") == "video"
    ]
    if len(video_streams) != 1:
        raise _unsupported_probe()
    return streams, video_streams[0]


def _layout_fractions(
    video: JsonMapping,
    width: int,
    height: int,
) -> tuple[Fraction, Fraction]:
    if _rotation(video) != 0:
        raise _incompatible_layout()
    sample_aspect_ratio = _parse_fraction(
        video.get("sample_aspect_ratio"),
        delimiters=(":", "/"),
        default=Fraction(1, 1),
    )
    display_aspect_ratio = Fraction(
        width * sample_aspect_ratio.numerator,
        height * sample_aspect_ratio.denominator,
    )
    if display_aspect_ratio != Fraction(16, 9):
        raise _incompatible_layout()
    return sample_aspect_ratio, display_aspect_ratio


def _decode_media(
    path: Path,
    metadata: ProbeMetadata,
    settings: ServiceSettings,
) -> int:
    layout_observer = _DecodedLayoutObserver(metadata, settings.limits.max_frames)
    arguments = (
        "-hide_banner",
        "-loglevel",
        "info",
        "-nostdin",
        "-xerror",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        ",".join(settings.limits.supported_demuxers),
        "-i",
        str(path),
        "-filter_complex",
        _layout_filter(metadata),
        "-map",
        "[decoded]",
        "-an",
        "-sn",
        "-dn",
        "-frames:v",
        str(settings.limits.max_frames + 1),
        "-f",
        "null",
        "-",
        "-progress",
        "pipe:1",
        "-nostats",
    )
    try:
        result = run_bounded_process(
            settings.ffmpeg_executable,
            arguments,
            timeout_seconds=settings.limits.process_timeout_seconds,
            max_output_bytes=settings.limits.max_process_output_bytes,
            stderr_line_observer=StderrLineObserver(
                layout_observer,
                MAX_SHOWINFO_LINE_BYTES,
            ),
        )
    except ProcessTimeoutError as error:
        raise MediaValidationError(
            code="PROCESS_TIMEOUT",
            stage="decode",
            safe_message="Media decoding exceeded its time limit.",
        ) from error
    except ProcessOutputLimitError as error:
        raise MediaValidationError(
            code="MEDIA_OVER_LIMIT",
            stage="decode",
            safe_message="Media decode output exceeded its limit.",
        ) from error

    if result.return_code != 0:
        raise MediaValidationError(
            code="CORRUPT_MEDIA",
            stage="decode",
            safe_message="The media failed bounded decoding.",
        )
    decoded_frame_count = _decoded_frame_count(result.stdout)
    if decoded_frame_count > settings.limits.max_frames:
        raise MediaValidationError(
            code="MEDIA_OVER_LIMIT",
            stage="decode",
            safe_message="The decoded frame count exceeds the configured limit.",
        )
    if decoded_frame_count <= 0:
        raise MediaValidationError(
            code="CORRUPT_MEDIA",
            stage="decode",
            safe_message="The media contains no decodable video frames.",
        )
    if layout_observer.frame_count != decoded_frame_count:
        raise _invalid_decode_output()
    return decoded_frame_count


def _layout_filter(metadata: ProbeMetadata) -> str:
    return f"[0:{metadata.video_stream_index}]showinfo=checksum=0[decoded]"


def _invalid_decode_output() -> MediaValidationError:
    return MediaValidationError(
        code="CORRUPT_MEDIA",
        stage="decode",
        safe_message="The media decoder returned invalid validation output.",
    )


def _incompatible_decoded_layout() -> MediaValidationError:
    return MediaValidationError(
        code="INCOMPATIBLE_LAYOUT",
        stage="decode",
        safe_message="Every decoded frame must preserve the 16:9 layout.",
    )


def _decoded_frame_count(progress: bytes) -> int:
    frame_count = 0
    try:
        lines = progress.decode("utf-8", errors="strict").splitlines()
    except UnicodeDecodeError as error:
        raise MediaValidationError(
            code="CORRUPT_MEDIA",
            stage="decode",
            safe_message="The media decoder returned invalid progress.",
        ) from error
    for line in lines:
        key, separator, value = line.partition("=")
        if key == "frame" and separator and value.isdecimal():
            frame_count = max(frame_count, int(value))
    return frame_count


def _media_facts(
    *,
    byte_count: int,
    checksum: str,
    metadata: ProbeMetadata,
    decoded_frame_count: int,
) -> MediaFacts:
    return MediaFacts.model_validate(
        {
            "byteCount": byte_count,
            "durationMs": metadata.duration_ms,
            "width": metadata.width,
            "height": metadata.height,
            "videoCodec": metadata.video_codec,
            "audioCodecs": metadata.audio_codecs,
            "containerFormats": metadata.container_formats,
            "decodedFrameCount": decoded_frame_count,
            "averageFrameRate": _rational(metadata.average_frame_rate),
            "timeBase": _rational(metadata.time_base),
            "sampleAspectRatio": _rational(metadata.sample_aspect_ratio),
            "displayAspectRatio": _rational(metadata.display_aspect_ratio),
            "startTimeMs": metadata.start_time_ms,
            "checksumSha256": checksum,
        }
    )


def _rational(value: Fraction) -> RationalValue:
    return RationalValue(numerator=value.numerator, denominator=value.denominator)


def _as_mapping(value: object) -> JsonMapping:
    if not isinstance(value, Mapping):
        raise _unsupported_probe()
    return cast("JsonMapping", value)


def _required_string(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise _unsupported_probe()
    return value


def _bounded_identifier(value: object) -> str:
    identifier = _required_string(value)
    if len(identifier) > MAX_IDENTIFIER_LENGTH or not all(
        character.isascii() and (character.isalnum() or character in "_-")
        for character in identifier
    ):
        raise _unsupported_probe()
    return identifier


def _positive_int(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise _unsupported_probe()
    return value


def _positive_or_zero_int(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise _unsupported_probe()
    return value


def _parse_fraction(
    value: object,
    *,
    delimiters: tuple[str, ...],
    default: Fraction | None = None,
) -> Fraction:
    if value in (None, "N/A") and default is not None:
        return default
    text = _required_string(value)
    for delimiter in delimiters:
        if delimiter in text:
            numerator_text, denominator_text = text.split(delimiter, maxsplit=1)
            try:
                fraction = Fraction(int(numerator_text), int(denominator_text))
            except (ValueError, ZeroDivisionError) as error:
                raise _unsupported_probe() from error
            if fraction <= 0:
                raise _unsupported_probe()
            return fraction
    raise _unsupported_probe()


def _parse_frame_rate(video: JsonMapping) -> Fraction:
    for field_name in ("avg_frame_rate", "r_frame_rate"):
        try:
            return _parse_fraction(video.get(field_name), delimiters=("/",))
        except MediaValidationError:
            continue
    raise _unsupported_probe()


def _duration_ms(video: JsonMapping, raw_format: JsonMapping) -> int:
    for value in (raw_format.get("duration"), video.get("duration")):
        try:
            duration_ms = _milliseconds(value)
        except MediaValidationError:
            continue
        if duration_ms > 0:
            return duration_ms
    raise _unsupported_probe()


def _milliseconds(value: object, *, allow_negative: bool = False) -> int:
    text = _required_string(value)
    try:
        seconds = Decimal(text)
    except InvalidOperation as error:
        raise _unsupported_probe() from error
    if not seconds.is_finite() or (seconds < 0 and not allow_negative):
        raise _unsupported_probe()
    return int((seconds * 1000).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _rotation(video: JsonMapping) -> int:
    tags_value = video.get("tags")
    if isinstance(tags_value, Mapping):
        tags = cast("JsonMapping", tags_value)
        rotation_value = tags.get("rotate")
        if rotation_value is not None:
            try:
                return int(_required_string(rotation_value)) % 360
            except ValueError as error:
                raise _unsupported_probe() from error

    side_data_value = video.get("side_data_list")
    if isinstance(side_data_value, list):
        for item in side_data_value:
            side_data = _as_mapping(item)
            rotation_value = side_data.get("rotation")
            if isinstance(rotation_value, int) and not isinstance(rotation_value, bool):
                return rotation_value % 360
    return 0


def _unsupported_probe() -> MediaValidationError:
    return MediaValidationError(
        code="UNSUPPORTED_MEDIA",
        stage="probe",
        safe_message="The media format or metadata is unsupported.",
    )


def _incompatible_layout() -> MediaValidationError:
    return MediaValidationError(
        code="INCOMPATIBLE_LAYOUT",
        stage="probe",
        safe_message="Version one requires an invariant 16:9 recording.",
    )


def _log_result(
    correlation_id: str,
    stage: str,
    started_at: float,
    outcome: str,
    media: MediaFacts | None = None,
) -> None:
    facts: dict[str, int | str] | None = None
    if media is not None:
        facts = {
            "byteCount": media.byte_count,
            "durationMs": media.duration_ms,
            "width": media.width,
            "height": media.height,
            "videoCodec": media.video_codec,
            "decodedFrameCount": media.decoded_frame_count,
        }
    log_stage(
        correlation_id=correlation_id,
        stage=stage,
        elapsed_ms=round((time.monotonic() - started_at) * 1000),
        outcome=outcome,
        facts=facts,
    )
