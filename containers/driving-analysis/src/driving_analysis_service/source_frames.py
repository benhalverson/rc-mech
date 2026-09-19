import base64
import threading
from typing import Annotated, Literal

from fastapi.responses import JSONResponse
from pydantic import Field, StringConstraints

from driving_analysis_service.contracts import (
    SHA256_PATTERN,
    StagedMediaInput,
    StrictContract,
)
from driving_analysis_service.errors import MediaValidationError
from driving_analysis_service.media import claim_staged_media, inspect_and_probe_media
from driving_analysis_service.preparation import _source_frames
from driving_analysis_service.processes import (
    ProcessOutputLimitError,
    ProcessTimeoutError,
    run_bounded_process,
)
from driving_analysis_service.processing_deadline import (
    check_deadline,
    remaining_seconds,
    start_deadline,
)
from driving_analysis_service.settings import ServiceSettings
from driving_analysis_service.tracking_contracts import RaceWindow

MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_IMAGE_BYTES = 8 * 1024 * 1024


class TimestampSelection(StrictContract):
    kind: Literal["timestamp"]
    timestamp_ms: int = Field(
        alias="timestampMs", ge=0, le=MAX_SAFE_INTEGER, strict=True
    )


class FrameSelection(StrictContract):
    kind: Literal["frame"]
    frame_index: int = Field(alias="frameIndex", ge=0, le=MAX_SAFE_INTEGER, strict=True)


class SourceFrameRequest(StrictContract):
    contract_version: Literal["source-frame.v1"] = Field(alias="contractVersion")
    input: StagedMediaInput
    source_checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="sourceChecksumSha256")
    selection: TimestampSelection | FrameSelection = Field(discriminator="kind")
    include_image: bool = Field(alias="includeImage", strict=True)


class SourceFrameResponse(StrictContract):
    contract_version: Literal["source-frame.v1"] = Field(alias="contractVersion")
    frame_index: int = Field(alias="frameIndex", ge=0, le=MAX_SAFE_INTEGER, strict=True)
    timestamp_ms: int = Field(
        alias="timestampMs", ge=0, le=MAX_SAFE_INTEGER, strict=True
    )
    source_checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="sourceChecksumSha256")
    image_base64: (
        Annotated[
            str,
            StringConstraints(max_length=((MAX_IMAGE_BYTES + 2) // 3) * 4, strict=True),
        ]
        | None
    ) = Field(alias="imageBase64")


FrameErrorCode = Literal[
    "INVALID_REQUEST",
    "SERVICE_BUSY",
    "PROCESS_TIMEOUT",
    "RESOURCE_LIMIT",
    "FRAME_UNAVAILABLE",
    "SOURCE_MISMATCH",
]


class SourceFrameError(StrictContract):
    code: FrameErrorCode
    message: Literal["source frame selection rejected"]


class SourceFrameErrorResponse(StrictContract):
    contract_version: Literal["source-frame.v1"] = Field(alias="contractVersion")
    error: SourceFrameError


def frame_error(code: FrameErrorCode, status: int) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content=SourceFrameErrorResponse(
            contractVersion="source-frame.v1",
            error=SourceFrameError(
                code=code, message="source frame selection rejected"
            ),
        ).model_dump(by_alias=True),
    )


class SourceFrameService:
    def __init__(
        self, settings: ServiceSettings, admission: threading.BoundedSemaphore
    ) -> None:
        self.settings = settings
        self.admission = admission

    def select(self, request: SourceFrameRequest) -> JSONResponse:
        if not self.admission.acquire(blocking=False):
            return frame_error("SERVICE_BUSY", 503)
        try:
            return self._select(request)
        except ProcessTimeoutError:
            return frame_error("PROCESS_TIMEOUT", 503)
        except ProcessOutputLimitError:
            return frame_error("RESOURCE_LIMIT", 422)
        except (MediaValidationError, OSError, ValueError):
            return frame_error("FRAME_UNAVAILABLE", 422)
        finally:
            self.admission.release()

    def _select(self, request: SourceFrameRequest) -> JSONResponse:
        settings = self.settings
        deadline = start_deadline(settings.limits.process_timeout_seconds)
        settings.prepare_roots()
        with claim_staged_media(request, settings, deadline=deadline) as source:
            _, checksum, metadata = inspect_and_probe_media(
                source,
                expected_byte_count=request.input.expected_byte_count,
                settings=settings,
                deadline=deadline,
            )
            if checksum != request.source_checksum_sha256:
                return frame_error("SOURCE_MISMATCH", 422)
            frames = _source_frames(
                source,
                RaceWindow(
                    startTimestampMs=0, endTimestampMs=settings.limits.max_duration_ms
                ),
                metadata,
                settings,
                deadline,
            )
            selection = request.selection
            selected = next(
                (
                    frame
                    for frame in frames
                    if (
                        frame.timestamp_ms >= selection.timestamp_ms
                        if isinstance(selection, TimestampSelection)
                        else frame.frame_index == selection.frame_index
                    )
                ),
                None,
            )
            if selected is None:
                return frame_error("FRAME_UNAVAILABLE", 422)
            image = None
            if request.include_image:
                result = run_bounded_process(
                    settings.ffmpeg_executable,
                    (
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-nostdin",
                        "-protocol_whitelist",
                        "file",
                        "-format_whitelist",
                        ",".join(settings.limits.supported_demuxers),
                        "-i",
                        str(source),
                        "-map",
                        f"0:{metadata.video_stream_index}",
                        "-vf",
                        f"select=eq(n\\,{selected.frame_index})",
                        "-frames:v",
                        "1",
                        "-an",
                        "-sn",
                        "-dn",
                        "-c:v",
                        "mjpeg",
                        "-f",
                        "image2pipe",
                        "pipe:1",
                    ),
                    timeout_seconds=remaining_seconds(deadline),
                    max_output_bytes=MAX_IMAGE_BYTES,
                )
                if result.return_code != 0 or not result.stdout.startswith(b"\xff\xd8"):
                    return frame_error("FRAME_UNAVAILABLE", 422)
                image = base64.b64encode(result.stdout).decode("ascii")
            check_deadline(deadline)
            return JSONResponse(
                content=SourceFrameResponse(
                    contractVersion="source-frame.v1",
                    frameIndex=selected.frame_index,
                    timestampMs=selected.timestamp_ms,
                    sourceChecksumSha256=checksum,
                    imageBase64=image,
                ).model_dump(by_alias=True)
            )
