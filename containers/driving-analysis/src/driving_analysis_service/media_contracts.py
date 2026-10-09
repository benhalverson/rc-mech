"""Internal validation API models consumed by the media service and its Worker caller.

Model responsibilities (kept here to preserve generated schema descriptions):
HealthResponse: Versioned ready response for the media validation endpoint.
StagedMediaInput: Identifies privately staged bytes and the declared size to check
    before validation.
MediaValidationRequest: Binds staged input to the validation contract and caller
    correlation ID.
MediaFacts: Returns bounded decoded-media facts needed by preparation without
    exposing
    a local path.
SafeError: Restricts validation failure detail so process paths and provider
    internals
    do not enter responses.
AcceptedValidationResponse: Carries validated media facts tied to the caller
    correlation ID.
RejectedValidationResponse: Carries a safe failure even when input validation could
    not recover a correlation ID.
"""
# ruff: noqa: EM101, TRY003

from typing import Annotated, Literal

from pydantic import (
    Field,
    StringConstraints,
    model_validator,
)

from driving_analysis_service.contract_primitives import (
    MAX_DECLARED_BYTES,
    SHA256_PATTERN,
    StrictContract,
    UuidV4String,
    _contains_control_character,
)
from driving_analysis_service.geometry_contracts import (
    RationalValue,
)

type ErrorCode = Literal[
    "INVALID_REQUEST",
    "SERVICE_UNAVAILABLE",
    "STAGED_MEDIA_NOT_FOUND",
    "STAGED_MEDIA_MISMATCH",
    "CORRUPT_MEDIA",
    "UNSUPPORTED_MEDIA",
    "MEDIA_OVER_LIMIT",
    "PROCESS_TIMEOUT",
    "INCOMPATIBLE_LAYOUT",
    "INTERNAL_ERROR",
    "SERVICE_BUSY",
]


type ErrorStage = Literal[
    "request",
    "claim",
    "inspect",
    "probe",
    "decode",
    "cleanup",
    "admission",
]


class HealthResponse(StrictContract):
    contract_version: Literal["race-video-validation.v1"] = Field(
        alias="contractVersion"
    )
    service: Literal["driving-analysis-media"]
    status: Literal["ready"]


class StagedMediaInput(StrictContract):
    staged_media_id: UuidV4String = Field(alias="stagedMediaId")
    expected_byte_count: Annotated[
        int,
        Field(alias="expectedByteCount", ge=1, le=MAX_DECLARED_BYTES, strict=True),
    ]


class MediaValidationRequest(StrictContract):
    contract_version: Literal["race-video-validation.v1"] = Field(
        alias="contractVersion"
    )
    correlation_id: UuidV4String = Field(alias="correlationId")
    input: StagedMediaInput


class MediaFacts(StrictContract):
    byte_count: Annotated[int, Field(alias="byteCount", gt=0, strict=True)]
    duration_ms: Annotated[int, Field(alias="durationMs", gt=0, strict=True)]
    width: Annotated[int, Field(gt=0, strict=True)]
    height: Annotated[int, Field(gt=0, strict=True)]
    video_codec: Annotated[
        str,
        StringConstraints(min_length=1, max_length=32, strict=True),
        Field(alias="videoCodec"),
    ]
    audio_codecs: Annotated[
        tuple[Annotated[str, StringConstraints(min_length=1, max_length=32)], ...],
        Field(alias="audioCodecs", max_length=8),
    ]
    container_formats: Annotated[
        tuple[Annotated[str, StringConstraints(min_length=1, max_length=32)], ...],
        Field(alias="containerFormats", min_length=1, max_length=8),
    ]
    decoded_frame_count: Annotated[
        int,
        Field(alias="decodedFrameCount", gt=0, strict=True),
    ]
    average_frame_rate: RationalValue = Field(alias="averageFrameRate")
    time_base: RationalValue = Field(alias="timeBase")
    sample_aspect_ratio: RationalValue = Field(alias="sampleAspectRatio")
    display_aspect_ratio: RationalValue = Field(alias="displayAspectRatio")
    start_time_ms: int = Field(alias="startTimeMs")
    checksum_sha256: Annotated[
        str,
        StringConstraints(pattern=SHA256_PATTERN, strict=True),
        Field(alias="checksumSha256"),
    ]


class SafeError(StrictContract):
    code: ErrorCode
    stage: ErrorStage
    message: Annotated[str, StringConstraints(min_length=1, max_length=160)]

    @model_validator(mode="after")
    def contains_no_sensitive_detail(self) -> "SafeError":
        lowered = self.message.lower()
        if any(
            value in lowered
            for value in (
                "://",
                "www.",
            )
        ) or _contains_control_character(self.message):
            raise ValueError("safe error contains disallowed detail")
        return self


class AcceptedValidationResponse(StrictContract):
    contract_version: Literal["race-video-validation.v1"] = Field(
        alias="contractVersion"
    )
    correlation_id: UuidV4String = Field(alias="correlationId")
    outcome: Literal["accepted"]
    media: MediaFacts


class RejectedValidationResponse(StrictContract):
    contract_version: Literal["race-video-validation.v1"] = Field(
        alias="contractVersion"
    )
    correlation_id: UuidV4String | None = Field(alias="correlationId")
    outcome: Literal["rejected"]
    error: SafeError


ValidationResponse = Annotated[
    AcceptedValidationResponse | RejectedValidationResponse,
    Field(discriminator="outcome"),
]
