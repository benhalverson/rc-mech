# Pydantic uses these messages as validation context; the service never emits
# them as public errors.
# ruff: noqa: EM101, TRY003

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

CONTRACT_VERSION: Literal["race-video-validation.v1"] = "race-video-validation.v1"
SERVICE_NAME: Literal["driving-analysis-media"] = "driving-analysis-media"
UUID_V4_PATTERN = (
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
SHA256_PATTERN = r"^[0-9a-f]{64}$"
MAX_DECLARED_BYTES = 50 * 1024 * 1024 * 1024
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
    code: ErrorCode
    stage: ErrorStage
    message: Annotated[str, StringConstraints(min_length=1, max_length=160)]

    @model_validator(mode="after")
    def contains_no_sensitive_detail(self) -> "SafeError":
        lowered = self.message.lower()
        if any(
            value in lowered
            for value in (
                "http://",
                "https://",
                "password",
                "token",
                "secret",
                "\n",
                "\r",
            )
        ):
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

# Subject-observation contracts are deliberately colocated with the media
# contract: both are wire contracts owned by this service, while benchmark
# calculations live in ``benchmark.py``.
SUBJECT_CONTRACT_VERSION: Literal["subject-observation.v1"] = "subject-observation.v1"
BENCHMARK_CONTRACT_VERSION: Literal["subject-benchmark.v1"] = "subject-benchmark.v1"
HEX_DIGEST_PATTERN = r"^[0-9a-f]{64}$"
CENTER_TOLERANCE = 1e-6


class NormalizedPoint(StrictContract):
    x: float = Field(ge=0.0, le=1.0, strict=True)
    y: float = Field(ge=0.0, le=1.0, strict=True)


class NormalizedBox(StrictContract):
    x: float = Field(ge=0.0, lt=1.0, strict=True)
    y: float = Field(ge=0.0, lt=1.0, strict=True)
    width: float = Field(gt=0.0, le=1.0, strict=True)
    height: float = Field(gt=0.0, le=1.0, strict=True)

    @model_validator(mode="after")
    def fits_in_frame(self) -> "NormalizedBox":
        if self.x + self.width > 1.0 or self.y + self.height > 1.0:
            raise ValueError("box must fit in normalized frame")
        return self


class SubjectProvenance(StrictContract):
    origin: Literal["provider"]
    provider: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    model: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    model_version: Annotated[str, StringConstraints(min_length=1, max_length=128)] = (
        Field(alias="modelVersion")
    )
    pipeline_version: Annotated[str, StringConstraints(min_length=1, max_length=64)] = (
        Field(alias="pipelineVersion")
    )
    configuration_digest: Annotated[
        str, StringConstraints(pattern=HEX_DIGEST_PATTERN, strict=True)
    ] = Field(alias="configurationDigest")
    model_digest: (
        Annotated[str, StringConstraints(pattern=HEX_DIGEST_PATTERN, strict=True)]
        | None
    ) = Field(default=None, alias="modelDigest")


class SubjectObservation(StrictContract):
    timestamp_ms: int = Field(alias="timestampMs", ge=0, strict=True)
    frame_index: int = Field(alias="frameIndex", ge=0, strict=True)
    box: NormalizedBox
    center: NormalizedPoint
    visibility: Literal["visible", "occluded", "uncertain"]
    identity_confidence: float = Field(
        alias="identityConfidence", ge=0.0, le=1.0, strict=True
    )
    identity: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    provenance: SubjectProvenance

    @model_validator(mode="after")
    def center_matches_box(self) -> "SubjectObservation":
        expected_x = self.box.x + self.box.width / 2
        expected_y = self.box.y + self.box.height / 2
        if (
            abs(self.center.x - expected_x) > CENTER_TOLERANCE
            or abs(self.center.y - expected_y) > CENTER_TOLERANCE
        ):
            raise ValueError("center must match box center")
        return self


class TrackingGap(StrictContract):
    start_timestamp_ms: int = Field(alias="startTimestampMs", ge=0, strict=True)
    end_timestamp_ms: int = Field(alias="endTimestampMs", ge=0, strict=True)
    reason: Literal["ambiguous-identity", "occluded", "missing"]

    @model_validator(mode="after")
    def ordered(self) -> "TrackingGap":
        if self.end_timestamp_ms <= self.start_timestamp_ms:
            raise ValueError("tracking gap must have positive duration")
        return self


class AcceptedSubjectObservations(StrictContract):
    contract_version: Literal["subject-observation.v1"] = Field(alias="contractVersion")
    outcome: Literal["accepted"]
    case_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="caseId"
    )
    observations: tuple[SubjectObservation, ...] = Field(
        min_length=1, max_length=100_000, strict=False
    )
    gaps: tuple[TrackingGap, ...] = Field(default=(), strict=False)

    @model_validator(mode="after")
    def observations_are_ordered(self) -> "AcceptedSubjectObservations":
        timestamps = [
            (item.timestamp_ms, item.frame_index) for item in self.observations
        ]
        if timestamps != sorted(timestamps) or len(set(timestamps)) != len(timestamps):
            raise ValueError("observations must be strictly ordered")
        return self


class RejectedSubjectObservations(StrictContract):
    contract_version: Literal["subject-observation.v1"] = Field(alias="contractVersion")
    outcome: Literal["rejected"]
    case_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] | None = (
        Field(alias="caseId")
    )
    error: SafeError


SubjectObservationEnvelope = Annotated[
    AcceptedSubjectObservations | RejectedSubjectObservations,
    Field(discriminator="outcome"),
]
AcceptedSubjectObservationEnvelope = AcceptedSubjectObservations
RejectedSubjectObservationEnvelope = RejectedSubjectObservations
CandidateObservations = AcceptedSubjectObservations


class DirectedGate(StrictContract):
    entry: NormalizedPoint
    exit: NormalizedPoint
    direction: Literal["positive", "negative"]

    @model_validator(mode="after")
    def non_degenerate(self) -> "DirectedGate":
        if self.entry == self.exit:
            raise ValueError("gate must have two distinct points")
        return self


class CornerGates(StrictContract):
    entry: DirectedGate
    exit: DirectedGate


class SubjectSeed(StrictContract):
    timestamp_ms: int = Field(alias="timestampMs", ge=0, strict=True)
    identity: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    box: NormalizedBox


class BenchmarkCase(StrictContract):
    case_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="caseId"
    )
    window_start_ms: int = Field(alias="windowStartMs", ge=0, strict=True)
    window_end_ms: int = Field(alias="windowEndMs", gt=0, strict=True)
    subject_seed: SubjectSeed = Field(alias="subjectSeed")

    @model_validator(mode="after")
    def window_is_ordered(self) -> "BenchmarkCase":
        if self.window_end_ms <= self.window_start_ms:
            raise ValueError("benchmark window must be ordered")
        if (
            not self.window_start_ms
            <= self.subject_seed.timestamp_ms
            <= self.window_end_ms
        ):
            raise ValueError("subject seed must be inside benchmark window")
        return self


class BenchmarkProvenance(StrictContract):
    docker_image_digest: Annotated[
        str, StringConstraints(pattern=HEX_DIGEST_PATTERN, strict=True)
    ] = Field(alias="dockerImageDigest")
    python_lockfile_digest: Annotated[
        str, StringConstraints(pattern=HEX_DIGEST_PATTERN, strict=True)
    ] = Field(alias="pythonLockfileDigest")
    ffmpeg_version: Annotated[str, StringConstraints(min_length=1, max_length=64)] = (
        Field(alias="ffmpegVersion")
    )
    model_digest: Annotated[
        str, StringConstraints(pattern=HEX_DIGEST_PATTERN, strict=True)
    ] = Field(alias="modelDigest")
    pipeline_version: Annotated[str, StringConstraints(min_length=1, max_length=64)] = (
        Field(alias="pipelineVersion")
    )


class CorpusManifest(StrictContract):
    contract_version: Literal["subject-benchmark.v1"] = Field(alias="contractVersion")
    corpus_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="corpusId"
    )
    cases: tuple[BenchmarkCase, ...] = Field(min_length=1, max_length=100, strict=False)
    required_coverage: float = Field(
        default=0.8, alias="requiredCoverage", ge=0.0, le=1.0, strict=True
    )
    provenance: BenchmarkProvenance


class GroundTruthPass(StrictContract):
    pass_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="passId"
    )
    corner_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="cornerId"
    )
    entry_timestamp_ms: int = Field(alias="entryTimestampMs", ge=0, strict=True)
    exit_timestamp_ms: int = Field(alias="exitTimestampMs", gt=0, strict=True)

    @model_validator(mode="after")
    def ordered(self) -> "GroundTruthPass":
        if self.exit_timestamp_ms <= self.entry_timestamp_ms:
            raise ValueError("ground-truth pass must be ordered")
        return self


class GroundTruthCase(StrictContract):
    case_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="caseId"
    )
    subject_identity: Annotated[str, StringConstraints(min_length=1, max_length=64)] = (
        Field(alias="subjectIdentity")
    )
    ambiguous_spans: tuple[TrackingGap, ...] = Field(
        default=(), alias="ambiguousSpans", strict=False
    )
    gates: dict[
        Annotated[str, StringConstraints(min_length=1, max_length=64)], CornerGates
    ]
    passes: tuple[GroundTruthPass, ...] = Field(default=(), strict=False)

    @model_validator(mode="after")
    def pass_corners_exist(self) -> "GroundTruthCase":
        if any(item.corner_id not in self.gates for item in self.passes):
            raise ValueError("ground-truth pass references an unknown corner")
        return self


class GroundTruth(StrictContract):
    contract_version: Literal["subject-benchmark.v1"] = Field(alias="contractVersion")
    corpus_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="corpusId"
    )
    cases: tuple[GroundTruthCase, ...] = Field(
        min_length=1, max_length=100, strict=False
    )


class BenchmarkReport(StrictContract):
    contract_version: Literal["subject-benchmark.v1"] = Field(alias="contractVersion")
    corpus_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="corpusId"
    )
    provenance: BenchmarkProvenance
    passed: bool
    coverage: dict[str, int | float]
    gaps: dict[str, int]
    identity: dict[str, int]
    timing: dict[str, float | int | None]
