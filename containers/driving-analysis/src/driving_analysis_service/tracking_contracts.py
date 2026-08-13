# Validation messages stay inside the Python service and are never returned as
# provider or media error detail.
# ruff: noqa: EM101, TRY003

from typing import Annotated, Literal

from pydantic import Field, StringConstraints, model_validator

from driving_analysis_service.contracts import (
    MAX_BENCHMARK_FRAME_COUNT,
    MAX_BENCHMARK_TIMESTAMP_MS,
    SHA256_PATTERN,
    NormalizedBox,
    RationalValue,
    SafeFreeFormIdentifier,
    StagedMediaInput,
    StrictContract,
    SubjectObservation,
    SubjectProvenance,
    SubjectSeed,
    UuidV4String,
)

PROCESSING_CONTRACT_VERSION: Literal["subject-tracking.v1"] = "subject-tracking.v1"
TRACK_VIEW_Y = 1 / 3
TRACK_VIEW_HEIGHT = 2 / 3


class RaceWindow(StrictContract):
    start_timestamp_ms: int = Field(
        alias="startTimestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    end_timestamp_ms: int = Field(
        alias="endTimestampMs", gt=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )

    @model_validator(mode="after")
    def ordered(self) -> "RaceWindow":
        if self.end_timestamp_ms <= self.start_timestamp_ms:
            raise ValueError("Race window must have positive duration")
        return self


class FixedTrackView(StrictContract):
    x: float = Field(ge=0.0, le=1.0, strict=True)
    y: float = Field(ge=0.0, le=1.0, strict=True)
    width: float = Field(gt=0.0, le=1.0, strict=True)
    height: float = Field(gt=0.0, le=1.0, strict=True)

    @model_validator(mode="after")
    def is_fixed_bottom_two_thirds(self) -> "FixedTrackView":
        if (self.x, self.y, self.width, self.height) != (
            0.0,
            TRACK_VIEW_Y,
            1.0,
            TRACK_VIEW_HEIGHT,
        ):
            raise ValueError("Track view must be the fixed bottom two-thirds")
        return self


class PrepareStageRequest(StrictContract):
    contract_version: Literal["subject-tracking.v1"] = Field(alias="contractVersion")
    correlation_id: UuidV4String = Field(alias="correlationId")
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    prepared_media_id: UuidV4String = Field(alias="preparedMediaId")
    input: StagedMediaInput
    window: RaceWindow
    pipeline_version: SafeFreeFormIdentifier = Field(alias="pipelineVersion")


class PreparedMediaArtifact(StrictContract):
    prepared_media_id: UuidV4String = Field(alias="preparedMediaId")
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    byte_count: int = Field(alias="byteCount", gt=0, strict=True)
    checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="checksumSha256")
    frame_manifest_byte_count: int = Field(
        alias="frameManifestByteCount", gt=0, strict=True
    )
    frame_manifest_checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="frameManifestChecksumSha256")
    source_byte_count: int = Field(alias="sourceByteCount", gt=0, strict=True)
    source_checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="sourceChecksumSha256")
    window: RaceWindow
    track_view: FixedTrackView = Field(alias="trackView")
    width: int = Field(gt=0, strict=True)
    height: int = Field(gt=0, strict=True)
    decoded_frame_count: int = Field(
        alias="decodedFrameCount",
        gt=0,
        le=MAX_BENCHMARK_FRAME_COUNT,
        strict=True,
    )
    average_frame_rate: RationalValue = Field(alias="averageFrameRate")
    ffmpeg_version: SafeFreeFormIdentifier = Field(alias="ffmpegVersion")
    pipeline_version: SafeFreeFormIdentifier = Field(alias="pipelineVersion")
    preparation_configuration_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="preparationConfigurationDigest")


class PreparedFrame(StrictContract):
    prepared_frame_index: int = Field(
        alias="preparedFrameIndex",
        ge=0,
        lt=MAX_BENCHMARK_FRAME_COUNT,
        strict=True,
    )
    frame_index: int = Field(
        alias="frameIndex", ge=0, lt=MAX_BENCHMARK_FRAME_COUNT, strict=True
    )
    timestamp_ms: int = Field(
        alias="timestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )


class PreparedFrameManifest(StrictContract):
    contract_version: Literal["subject-tracking.v1"] = Field(alias="contractVersion")
    prepared_media_id: UuidV4String = Field(alias="preparedMediaId")
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    source_checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="sourceChecksumSha256")
    source_byte_count: int = Field(alias="sourceByteCount", gt=0, strict=True)
    window: RaceWindow
    track_view: FixedTrackView = Field(alias="trackView")
    media_byte_count: int = Field(alias="mediaByteCount", gt=0, strict=True)
    media_checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="mediaChecksumSha256")
    width: int = Field(gt=0, strict=True)
    height: int = Field(gt=0, strict=True)
    average_frame_rate: RationalValue = Field(alias="averageFrameRate")
    ffmpeg_version: SafeFreeFormIdentifier = Field(alias="ffmpegVersion")
    pipeline_version: SafeFreeFormIdentifier = Field(alias="pipelineVersion")
    preparation_configuration_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="preparationConfigurationDigest")
    frames: tuple[PreparedFrame, ...] = Field(
        min_length=1,
        max_length=MAX_BENCHMARK_FRAME_COUNT,
        strict=False,
    )

    @model_validator(mode="after")
    def frames_are_ordered(self) -> "PreparedFrameManifest":
        if any(
            current.prepared_frame_index != previous.prepared_frame_index + 1
            or current.frame_index <= previous.frame_index
            or current.timestamp_ms <= previous.timestamp_ms
            for previous, current in zip(self.frames, self.frames[1:], strict=False)
        ):
            raise ValueError("prepared frames must be strictly ordered")
        if self.frames[0].prepared_frame_index != 0:
            raise ValueError("prepared frame indexes must start at zero")
        if any(
            not self.window.start_timestamp_ms
            <= frame.timestamp_ms
            < self.window.end_timestamp_ms
            for frame in self.frames
        ):
            raise ValueError("prepared frames must remain inside the Race window")
        return self


class PrepareStageAccepted(StrictContract):
    contract_version: Literal["subject-tracking.v1"] = Field(alias="contractVersion")
    correlation_id: UuidV4String = Field(alias="correlationId")
    outcome: Literal["accepted"]
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    prepared: PreparedMediaArtifact


type ProcessingErrorCode = Literal[
    "INVALID_REQUEST",
    "MEDIA_UNAVAILABLE",
    "PREPARATION_FAILED",
    "PROCESS_TIMEOUT",
    "INFERENCE_UNAVAILABLE",
    "INFERENCE_FAILED",
    "RESOURCE_LIMIT",
    "ARTIFACT_CONFLICT",
]
type ProcessingErrorStage = Literal[
    "request",
    "prepare",
    "initialize",
    "track",
    "serialize",
]
type ProcessingErrorMessage = Literal[
    "processing request rejected",
    "processing media unavailable",
    "Race window preparation failed safely",
    "processing exceeded its time limit",
    "inference provider unavailable",
    "inference failed safely",
    "processing resource limit exceeded",
    "immutable artifact already exists",
]

PROCESSING_ERROR_FIELDS: dict[
    ProcessingErrorCode,
    tuple[ProcessingErrorStage, ProcessingErrorMessage],
] = {
    "INVALID_REQUEST": ("request", "processing request rejected"),
    "MEDIA_UNAVAILABLE": ("prepare", "processing media unavailable"),
    "PREPARATION_FAILED": (
        "prepare",
        "Race window preparation failed safely",
    ),
    "PROCESS_TIMEOUT": ("track", "processing exceeded its time limit"),
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


class ProcessingSafeError(StrictContract):
    code: ProcessingErrorCode
    stage: ProcessingErrorStage
    message: ProcessingErrorMessage

    @model_validator(mode="after")
    def fields_are_canonical(self) -> "ProcessingSafeError":
        if self.code == "PROCESS_TIMEOUT":
            if (
                self.stage not in {"prepare", "track"}
                or self.message != "processing exceeded its time limit"
            ):
                raise ValueError("processing timeout error fields must be canonical")
            return self
        if (self.stage, self.message) != PROCESSING_ERROR_FIELDS[self.code]:
            raise ValueError("processing error fields must be canonical")
        return self


class ProcessingRejected(StrictContract):
    contract_version: Literal["subject-tracking.v1"] = Field(alias="contractVersion")
    correlation_id: UuidV4String | None = Field(alias="correlationId")
    outcome: Literal["rejected"]
    case_id: SafeFreeFormIdentifier | None = Field(alias="caseId")
    error: ProcessingSafeError


PrepareStageResponse = Annotated[
    PrepareStageAccepted | ProcessingRejected,
    Field(discriminator="outcome"),
]


class TrackStageRequest(StrictContract):
    contract_version: Literal["subject-tracking.v1"] = Field(alias="contractVersion")
    correlation_id: UuidV4String = Field(alias="correlationId")
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    observation_segment_id: UuidV4String = Field(alias="observationSegmentId")
    prepared: PreparedMediaArtifact
    subject_seed: SubjectSeed = Field(alias="subjectSeed")

    @model_validator(mode="after")
    def seed_is_inside_prepared_window(self) -> "TrackStageRequest":
        if not (
            self.prepared.window.start_timestamp_ms
            <= self.subject_seed.timestamp_ms
            < self.prepared.window.end_timestamp_ms
        ):
            raise ValueError("Subject seed must be inside the prepared Race window")
        return self


class OpenTrackingGap(StrictContract):
    start_timestamp_ms: int = Field(
        alias="startTimestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    reason: Literal["ambiguous-identity", "occluded", "missing"]


class SubjectObservationSegment(StrictContract):
    contract_version: Literal["subject-observation-segment.v1"] = Field(
        alias="contractVersion"
    )
    outcome: Literal["accepted"]
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    observations: tuple[SubjectObservation, ...] = Field(
        max_length=MAX_BENCHMARK_FRAME_COUNT,
        strict=False,
    )
    open_gap: OpenTrackingGap | None = Field(alias="openGap")
    provenance: SubjectProvenance

    @model_validator(mode="after")
    def observations_precede_gap(self) -> "SubjectObservationSegment":
        if self.open_gap is not None and any(
            observation.timestamp_ms >= self.open_gap.start_timestamp_ms
            for observation in self.observations
        ):
            raise ValueError("observations must precede the open Tracking gap")
        return self


class ObservationSegmentArtifact(StrictContract):
    observation_segment_id: UuidV4String = Field(alias="observationSegmentId")
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    byte_count: int = Field(alias="byteCount", gt=0, strict=True)
    checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="checksumSha256")
    content_encoding: Literal["gzip"] = Field(alias="contentEncoding")
    media_type: Literal["application/vnd.rc-mech.subject-observations+json"] = Field(
        alias="mediaType"
    )
    observation_count: int = Field(
        alias="observationCount",
        ge=0,
        le=MAX_BENCHMARK_FRAME_COUNT,
        strict=True,
    )
    completed: bool
    gap: OpenTrackingGap | None
    provenance: SubjectProvenance
    ffmpeg_version: SafeFreeFormIdentifier = Field(alias="ffmpegVersion")
    source_checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="sourceChecksumSha256")
    prepared_checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="preparedChecksumSha256")
    preparation_configuration_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="preparationConfigurationDigest")

    @model_validator(mode="after")
    def completion_matches_gap(self) -> "ObservationSegmentArtifact":
        if self.completed == (self.gap is not None):
            raise ValueError("completed segments must not contain a Tracking gap")
        return self


class TrackStageAccepted(StrictContract):
    contract_version: Literal["subject-tracking.v1"] = Field(alias="contractVersion")
    correlation_id: UuidV4String = Field(alias="correlationId")
    outcome: Literal["accepted"]
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    segment: ObservationSegmentArtifact


TrackStageResponse = Annotated[
    TrackStageAccepted | ProcessingRejected,
    Field(discriminator="outcome"),
]


class ProviderCandidate(StrictContract):
    box: NormalizedBox | None
    identity_confidence: float = Field(
        alias="identityConfidence", ge=0.0, le=1.0, strict=True
    )
    visibility: Literal["visible", "occluded", "uncertain"]

    @model_validator(mode="after")
    def visible_candidate_has_a_box(self) -> "ProviderCandidate":
        if self.visibility == "visible" and self.box is None:
            raise ValueError("visible provider candidates require a box")
        return self
