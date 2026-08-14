# Strict, provider-neutral contracts for immutable Corner-clip rendering.
# ruff: noqa: EM101, TRY003

from typing import Annotated, Literal

from pydantic import Field, StringConstraints, model_validator

from driving_analysis_service.contracts import (
    MAX_BENCHMARK_TIMESTAMP_MS,
    SHA256_PATTERN,
    DirectedGate,
    NormalizedBox,
    NormalizedPoint,
    SafeFreeFormIdentifier,
    StagedMediaInput,
    StrictContract,
    UuidV4String,
)

RENDER_CONTRACT_VERSION: Literal["corner-render.v1"] = "corner-render.v1"
RENDER_PIPELINE_VERSION: Literal["corner-render.v1"] = "corner-render.v1"
CORNER_CLIP_MEDIA_TYPE: Literal["video/mp4"] = "video/mp4"
MAX_RENDER_OUTPUT_BYTES = 512 * 1024 * 1024
MAX_RENDER_DURATION_MS = 15 * 60 * 1000


class RenderPadding(StrictContract):
    before_ms: Literal[500] = Field(alias="beforeMs")
    after_ms: Literal[500] = Field(alias="afterMs")


class RenderOverlay(StrictContract):
    subject_center: NormalizedPoint = Field(alias="subjectCenter")
    entry_gate: DirectedGate = Field(alias="entryGate")
    exit_gate: DirectedGate = Field(alias="exitGate")


class RenderSpecification(StrictContract):
    source_checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="sourceChecksumSha256")
    run_id: SafeFreeFormIdentifier = Field(alias="runId")
    track_map_version: SafeFreeFormIdentifier = Field(alias="trackMapVersion")
    corner_id: SafeFreeFormIdentifier = Field(alias="cornerId")
    corner_view: NormalizedBox = Field(alias="cornerView")
    entry_timestamp_ms: int = Field(
        alias="entryTimestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    exit_timestamp_ms: int = Field(
        alias="exitTimestampMs", gt=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    padding: RenderPadding
    overlay: RenderOverlay
    max_output_bytes: int = Field(
        alias="maxOutputBytes",
        gt=0,
        le=MAX_RENDER_OUTPUT_BYTES,
        strict=True,
    )
    pipeline_version: Literal["corner-render.v1"] = Field(alias="pipelineVersion")

    @model_validator(mode="after")
    def is_ordered_and_bounded(self) -> "RenderSpecification":
        if self.exit_timestamp_ms <= self.entry_timestamp_ms:
            raise ValueError("render timestamps must be ordered")
        duration = (
            self.exit_timestamp_ms
            - self.entry_timestamp_ms
            + self.padding.before_ms
            + self.padding.after_ms
        )
        if duration > MAX_RENDER_DURATION_MS:
            raise ValueError("render duration exceeds the configured maximum")
        points = (
            self.overlay.subject_center,
            self.overlay.entry_gate.entry,
            self.overlay.entry_gate.exit,
            self.overlay.exit_gate.entry,
            self.overlay.exit_gate.exit,
        )
        if any(
            point.x < self.corner_view.x
            or point.x > self.corner_view.x + self.corner_view.width
            or point.y < self.corner_view.y
            or point.y > self.corner_view.y + self.corner_view.height
            for point in points
        ):
            raise ValueError("render overlay points must lie inside cornerView")
        return self


class RenderStageRequest(StrictContract):
    contract_version: Literal["corner-render.v1"] = Field(alias="contractVersion")
    correlation_id: UuidV4String = Field(alias="correlationId")
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    render_id: UuidV4String = Field(alias="renderId")
    input: StagedMediaInput
    specification: RenderSpecification


class RenderArtifact(StrictContract):
    render_id: UuidV4String = Field(alias="renderId")
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    content_type: Literal["video/mp4"] = Field(alias="contentType")
    byte_count: int = Field(alias="byteCount", gt=0, strict=True)
    checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="checksumSha256")
    duration_ms: int = Field(
        alias="durationMs", gt=0, le=MAX_RENDER_DURATION_MS, strict=True
    )
    render_input_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="renderInputDigest")
    source_checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="sourceChecksumSha256")
    ffmpeg_version: SafeFreeFormIdentifier = Field(alias="ffmpegVersion")
    pipeline_version: Literal["corner-render.v1"] = Field(alias="pipelineVersion")
    elapsed_ms: int = Field(alias="elapsedMs", ge=0, strict=True)


class RenderStageAccepted(StrictContract):
    contract_version: Literal["corner-render.v1"] = Field(alias="contractVersion")
    correlation_id: UuidV4String = Field(alias="correlationId")
    outcome: Literal["accepted"]
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    artifact: RenderArtifact


type RenderErrorCode = Literal[
    "INVALID_REQUEST",
    "MEDIA_UNAVAILABLE",
    "RENDER_FAILED",
    "PROCESS_TIMEOUT",
    "RESOURCE_LIMIT",
    "ARTIFACT_CONFLICT",
    "SERVICE_BUSY",
]
type RenderErrorStage = Literal["request", "render", "serialize", "admission"]
type RenderErrorMessage = Literal[
    "render request rejected",
    "render media unavailable",
    "Corner clip rendering failed safely",
    "render exceeded its time limit",
    "render output exceeded its limit",
    "immutable render artifact already exists",
    "render service is busy",
]


class RenderSafeError(StrictContract):
    code: RenderErrorCode
    stage: RenderErrorStage
    message: RenderErrorMessage


class RenderStageRejected(StrictContract):
    contract_version: Literal["corner-render.v1"] = Field(alias="contractVersion")
    correlation_id: UuidV4String | None = Field(alias="correlationId")
    outcome: Literal["rejected"]
    case_id: SafeFreeFormIdentifier | None = Field(alias="caseId")
    error: RenderSafeError


RenderStageResponse = RenderStageAccepted | RenderStageRejected
