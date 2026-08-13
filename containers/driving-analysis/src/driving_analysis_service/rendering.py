# Bounded, deterministic FFmpeg Corner-clip rendering.

import hashlib
import tempfile
import threading
import time
from pathlib import Path

from pydantic import ValidationError

from driving_analysis_service.contracts import (
    DirectedGate,
    NormalizedBox,
    NormalizedPoint,
)
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
from driving_analysis_service.processing_deadline import (
    remaining_seconds,
    start_deadline,
)
from driving_analysis_service.rendering_contracts import (
    CORNER_CLIP_MEDIA_TYPE,
    RENDER_CONTRACT_VERSION,
    RENDER_PIPELINE_VERSION,
    RenderArtifact,
    RenderErrorCode,
    RenderErrorMessage,
    RenderErrorStage,
    RenderOverlay,
    RenderSafeError,
    RenderSpecification,
    RenderStageAccepted,
    RenderStageRejected,
    RenderStageRequest,
    RenderStageResponse,
)
from driving_analysis_service.settings import ServiceSettings
from driving_analysis_service.tracking_artifacts import (
    ArtifactConflictError,
    InvalidArtifactError,
    bundle_member_path,
    bundle_path,
    canonical_json,
    file_digest,
    publish_bundle,
    read_completion,
    read_verified_artifact,
)

RENDER_BUNDLE_SUFFIX = ".corner"
RENDER_MEDIA_SUFFIX = ".corner.mp4"
RENDER_COMPLETION_SUFFIX = ".corner.json"
MAX_FFMPEG_VERSION_BYTES = 16 * 1024
MIN_OUTPUT_DIMENSION = 2


class RenderInvalidMediaError(ValueError):
    """The source media cannot satisfy a render specification."""


class RenderProcessError(RuntimeError):
    """FFmpeg could not produce the requested clip."""


class CornerRenderService:
    def __init__(
        self,
        settings: ServiceSettings,
        admission: threading.BoundedSemaphore | None = None,
    ) -> None:
        self.settings = settings
        self._admission = admission or threading.BoundedSemaphore(
            settings.limits.max_concurrent_processing
        )

    def render(  # noqa: C901, PLR0911 - each safe failure maps directly to one response
        self, request: RenderStageRequest
    ) -> RenderStageResponse:
        if not self._admission.acquire(blocking=False):
            return _rejected(request, "SERVICE_BUSY")
        started_at = time.monotonic()
        try:
            return self._render(
                request,
                start_deadline(self.settings.limits.process_timeout_seconds),
                started_at,
            )
        except MediaValidationError as error:
            if error.code == "PROCESS_TIMEOUT":
                return _rejected(request, "PROCESS_TIMEOUT")
            return _rejected(request, "MEDIA_UNAVAILABLE")
        except RenderInvalidMediaError:
            return _rejected(request, "MEDIA_UNAVAILABLE")
        except RenderProcessError:
            return _rejected(request, "RENDER_FAILED")
        except InvalidArtifactError:
            return _rejected(request, "RENDER_FAILED")
        except ArtifactConflictError:
            return _rejected(request, "ARTIFACT_CONFLICT")
        except ProcessTimeoutError:
            return _rejected(request, "PROCESS_TIMEOUT")
        except ProcessOutputLimitError:
            return _rejected(request, "RESOURCE_LIMIT")
        except (OSError, ValidationError, ValueError):
            return _rejected(request, "RENDER_FAILED")
        finally:
            self._admission.release()

    def _render(
        self,
        request: RenderStageRequest,
        deadline: float,
        started_at: float,
    ) -> RenderStageResponse:
        self.settings.prepare_roots()
        recovered = _recover(request, self.settings, deadline)
        if recovered is not None:
            return _accepted(request, recovered)

        with claim_staged_media(request, self.settings, deadline=deadline) as source:
            source_bytes, source_checksum, metadata = inspect_and_probe_media(
                source,
                expected_byte_count=request.input.expected_byte_count,
                settings=self.settings,
                deadline=deadline,
            )
            specification = request.specification
            if source_checksum != specification.source_checksum_sha256:
                raise RenderInvalidMediaError
            _validate_specification(specification, source_bytes, metadata.duration_ms)
            ffmpeg_version = _ffmpeg_version(self.settings, deadline)
            render_input_digest = _render_input_digest(request, ffmpeg_version)
            work_path = self.settings.work_root / f"{request.render_id}.corner.mp4"
            try:
                _render_clip(
                    source, work_path, specification, metadata, self.settings, deadline
                )
                output_checksum, output_bytes = file_digest(
                    work_path,
                    max_bytes=specification.max_output_bytes,
                    deadline=deadline,
                )
                duration_ms = _output_duration(work_path, self.settings, deadline)
                artifact = RenderArtifact(
                    renderId=request.render_id,
                    caseId=request.case_id,
                    contentType=CORNER_CLIP_MEDIA_TYPE,
                    byteCount=output_bytes,
                    checksumSha256=output_checksum,
                    durationMs=duration_ms,
                    renderInputDigest=render_input_digest,
                    sourceChecksumSha256=source_checksum,
                    ffmpegVersion=ffmpeg_version,
                    pipelineVersion=RENDER_PIPELINE_VERSION,
                    elapsedMs=max(0, round((time.monotonic() - started_at) * 1000)),
                )
                completion = canonical_json(
                    artifact.model_dump(mode="json", by_alias=True)
                )
                created = publish_bundle(
                    bundle_path(self.settings, request.render_id, RENDER_BUNDLE_SUFFIX),
                    {
                        f"{request.render_id}{RENDER_MEDIA_SUFFIX}": work_path,
                        f"{request.render_id}{RENDER_COMPLETION_SUFFIX}": completion,
                    },
                    deadline=deadline,
                )
                if not created:
                    recovered = _recover(request, self.settings, deadline)
                    if recovered is None or recovered != artifact:
                        raise ArtifactConflictError
                    artifact = recovered
                return _accepted(request, artifact)
            finally:
                work_path.unlink(missing_ok=True)


def _accepted(
    request: RenderStageRequest, artifact: RenderArtifact
) -> RenderStageAccepted:
    return RenderStageAccepted(
        contractVersion=RENDER_CONTRACT_VERSION,
        correlationId=request.correlation_id,
        outcome="accepted",
        caseId=request.case_id,
        artifact=artifact,
    )


def _rejected(
    request: RenderStageRequest, code: RenderErrorCode
) -> RenderStageRejected:
    fields: dict[RenderErrorCode, tuple[RenderErrorStage, RenderErrorMessage]] = {
        "MEDIA_UNAVAILABLE": ("render", "render media unavailable"),
        "ARTIFACT_CONFLICT": ("serialize", "immutable render artifact already exists"),
        "PROCESS_TIMEOUT": ("render", "render exceeded its time limit"),
        "RESOURCE_LIMIT": ("serialize", "render output exceeded its limit"),
        "RENDER_FAILED": ("render", "Corner clip rendering failed safely"),
        "SERVICE_BUSY": ("admission", "render service is busy"),
        "INVALID_REQUEST": ("request", "render request rejected"),
    }
    stage, message = fields[code]
    return RenderStageRejected(
        contractVersion=RENDER_CONTRACT_VERSION,
        correlationId=request.correlation_id,
        outcome="rejected",
        caseId=request.case_id,
        error=RenderSafeError(code=code, stage=stage, message=message),
    )


def _recover(
    request: RenderStageRequest,
    settings: ServiceSettings,
    deadline: float,
) -> RenderArtifact | None:
    bundle = bundle_path(settings, request.render_id, RENDER_BUNDLE_SUFFIX)
    if not bundle.exists():
        return None
    completion = read_completion(
        bundle_member_path(
            settings, request.render_id, RENDER_BUNDLE_SUFFIX, RENDER_COMPLETION_SUFFIX
        ),
        RenderArtifact,
        max_bytes=64 * 1024,
        deadline=deadline,
    )
    if completion is None:
        return None
    if (
        completion.render_id != request.render_id
        or completion.case_id != request.case_id
        or completion.source_checksum_sha256
        != request.specification.source_checksum_sha256
        or completion.render_input_digest
        != _render_input_digest(request, completion.ffmpeg_version)
    ):
        raise ArtifactConflictError
    media = bundle_member_path(
        settings, request.render_id, RENDER_BUNDLE_SUFFIX, RENDER_MEDIA_SUFFIX
    )
    media_bytes = read_verified_artifact(
        media,
        expected_bytes=completion.byte_count,
        expected_checksum=completion.checksum_sha256,
        max_bytes=request.specification.max_output_bytes,
        deadline=deadline,
    )
    with tempfile.NamedTemporaryFile(
        mode="wb", prefix="recovery-", suffix=".mp4", dir=settings.work_root
    ) as recovery_media:
        recovery_media.write(media_bytes)
        recovery_media.flush()
        if (
            _output_duration(Path(recovery_media.name), settings, deadline)
            != completion.duration_ms
        ):
            raise ArtifactConflictError
    return completion


def _validate_specification(
    specification: RenderSpecification, source_bytes: int, duration_ms: int
) -> None:
    if source_bytes <= 0 or specification.exit_timestamp_ms > duration_ms:
        raise RenderInvalidMediaError
    padded_start = specification.entry_timestamp_ms - specification.padding.before_ms
    padded_end = specification.exit_timestamp_ms + specification.padding.after_ms
    if padded_start < 0 or padded_end > duration_ms:
        # The clip is clamped at the source boundary, preserving the requested
        # gate-to-gate interval while avoiding synthetic frames.
        return


def _render_clip(  # noqa: PLR0913 - FFmpeg invocation requires explicit bounded inputs
    source: Path,
    destination: Path,
    specification: RenderSpecification,
    metadata: ProbeMetadata,
    settings: ServiceSettings,
    deadline: float,
) -> None:
    duration_ms = metadata.duration_ms
    start_ms = max(
        0, specification.entry_timestamp_ms - specification.padding.before_ms
    )
    end_ms = min(
        duration_ms, specification.exit_timestamp_ms + specification.padding.after_ms
    )
    view = specification.corner_view
    overlay = specification.overlay
    crop_width = int(metadata.width * view.width) // 2 * 2
    crop_height = int(metadata.height * view.height) // 2 * 2
    if crop_width < MIN_OUTPUT_DIMENSION or crop_height < MIN_OUTPUT_DIMENSION:
        raise RenderInvalidMediaError
    overlay_path = destination.with_suffix(".ass")
    _write_overlay_script(overlay_path, overlay, view, crop_width, crop_height)
    filters = ",".join(
        (
            f"trim=start={(metadata.start_time_ms + start_ms) / 1000:.3f}:"
            f"end={(metadata.start_time_ms + end_ms) / 1000:.3f}",
            f"crop={crop_width}:{crop_height}:"
            f"trunc(iw*{view.x:.9f}/2)*2:trunc(ih*{view.y:.9f}/2)*2",
            "setpts=PTS-STARTPTS",
            f"ass=filename={overlay_path}",
        )
    )
    try:
        result = run_bounded_process(
            settings.ffmpeg_executable,
            (
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-xerror",
                "-copyts",
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                ",".join(settings.limits.supported_demuxers),
                "-i",
                str(source),
                "-map",
                f"0:{metadata.video_stream_index}",
                "-vf",
                filters,
                "-an",
                "-sn",
                "-dn",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+frag_keyframe+empty_moov+default_base_moof",
                "-f",
                "mp4",
                "pipe:1",
            ),
            timeout_seconds=remaining_seconds(deadline),
            max_output_bytes=specification.max_output_bytes,
        )
    finally:
        overlay_path.unlink(missing_ok=True)
    if result.return_code != 0 or not result.stdout:
        raise RenderProcessError
    destination.write_bytes(result.stdout)


def _write_overlay_script(
    destination: Path,
    overlay: RenderOverlay,
    view: NormalizedBox,
    width: int,
    height: int,
) -> None:
    subject = _pixel_point(overlay.subject_center, view, width, height)
    entry = _pixel_gate(overlay.entry_gate, view, width, height)
    exit_gate = _pixel_gate(overlay.exit_gate, view, width, height)
    subject_x, subject_y = subject
    subject_box = _ass_rectangle(subject_x, subject_y, 6, 6)
    lines = (
        _ass_line(entry, "&H00FFFF&"),
        _ass_line(exit_gate, "&HFFFF00&"),
        _ass_path(subject_box, "&HFFFFFF&"),
    )
    destination.write_text(
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "Style: Default,Arial,12,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,"
        "0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text\n"
        + "\n".join(
            f"Dialogue: 0,0:00:00.00,9:59:59.00,Default,,0,0,0,,{line}"
            for line in lines
        )
        + "\n",
        encoding="utf-8",
    )


def _pixel_point(
    point: NormalizedPoint, view: NormalizedBox, width: int, height: int
) -> tuple[int, int]:
    return (
        round((point.x - view.x) / view.width * width),
        round((point.y - view.y) / view.height * height),
    )


def _pixel_gate(
    gate: DirectedGate, view: NormalizedBox, width: int, height: int
) -> tuple[tuple[int, int], tuple[int, int]]:
    return (
        _pixel_point(gate.entry, view, width, height),
        _pixel_point(gate.exit, view, width, height),
    )


def _ass_line(line: tuple[tuple[int, int], tuple[int, int]], color: str) -> str:
    return (
        "{\\p1\\bord2\\1c"
        f"{color}}}m {line[0][0]} {line[0][1]} l {line[1][0]} {line[1][1]}{{\\p0}}"
    )


def _ass_rectangle(
    x: int, y: int, width: int, height: int
) -> tuple[tuple[int, int], tuple[int, int], tuple[int, int], tuple[int, int]]:
    return (
        (x - width, y - height),
        (x + width, y - height),
        (x + width, y + height),
        (x - width, y + height),
    )


def _ass_path(points: tuple[tuple[int, int], ...], color: str) -> str:
    start = points[0]
    segments = " ".join(f"l {x} {y}" for x, y in (*points[1:], start))
    return f"{{\\p1\\bord2\\1c{color}}}m {start[0]} {start[1]} {segments}{{\\p0}}"


def _ffmpeg_version(settings: ServiceSettings, deadline: float) -> str:
    result = run_bounded_process(
        settings.ffmpeg_executable,
        ("-version",),
        timeout_seconds=remaining_seconds(deadline),
        max_output_bytes=MAX_FFMPEG_VERSION_BYTES,
    )
    if result.return_code != 0:
        raise RenderInvalidMediaError
    try:
        first_line = result.stdout.decode("utf-8", errors="strict").splitlines()[0]
        prefix, version, value, *_ = first_line.split()
    except (IndexError, UnicodeDecodeError, ValueError) as error:
        raise RenderInvalidMediaError from error
    if prefix != "ffmpeg" or version != "version":
        raise RenderInvalidMediaError
    return value


def _output_duration(path: Path, settings: ServiceSettings, deadline: float) -> int:
    result = run_bounded_process(
        settings.ffprobe_executable,
        (
            "-hide_banner",
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ),
        timeout_seconds=remaining_seconds(deadline),
        max_output_bytes=settings.limits.max_process_output_bytes,
    )
    if result.return_code != 0:
        raise RenderInvalidMediaError
    try:
        duration_ms = round(
            float(result.stdout.decode("ascii", errors="strict").strip()) * 1000
        )
    except (UnicodeDecodeError, ValueError) as error:
        raise RenderInvalidMediaError from error
    if duration_ms <= 0:
        raise RenderInvalidMediaError
    return duration_ms


def _render_input_digest(request: RenderStageRequest, ffmpeg_version: str) -> str:
    payload = {
        "contractVersion": request.contract_version,
        "caseId": request.case_id,
        "renderId": request.render_id,
        "expectedByteCount": request.input.expected_byte_count,
        "specification": request.specification.model_dump(mode="json", by_alias=True),
        "ffmpegVersion": ffmpeg_version,
    }
    return hashlib.sha256(canonical_json(payload)).hexdigest()
