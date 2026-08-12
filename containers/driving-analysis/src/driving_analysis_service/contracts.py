from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

CONTRACT_VERSION: Literal["race-video-validation.v1"] = "race-video-validation.v1"
SERVICE_NAME: Literal["driving-analysis-media"] = "driving-analysis-media"
UUID_V4_PATTERN = (
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
SHA256_PATTERN = r"^[0-9a-f]{64}$"
MAX_DECLARED_BYTES = 50 * 1024 * 1024 * 1024

UuidV4String = Annotated[
    str,
    StringConstraints(
        min_length=36,
        max_length=36,
        pattern=UUID_V4_PATTERN,
        strict=True,
    ),
]


class StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


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


class RationalValue(StrictContract):
    numerator: int
    denominator: Annotated[int, Field(gt=0, strict=True)]


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
    code: Literal[
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
    ]
    stage: Literal["request", "claim", "inspect", "probe", "decode", "cleanup"]
    message: Annotated[str, StringConstraints(min_length=1, max_length=160)]


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
