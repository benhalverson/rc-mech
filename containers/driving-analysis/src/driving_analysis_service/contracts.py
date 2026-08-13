# Pydantic uses these messages as validation context; the service never emits
# them as public errors.
# ruff: noqa: EM101, TRY003

import re
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

CONTRACT_VERSION: Literal["race-video-validation.v1"] = "race-video-validation.v1"
SERVICE_NAME: Literal["driving-analysis-media"] = "driving-analysis-media"
UUID_V4_PATTERN = (
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
SHA256_PATTERN = r"^[0-9a-f]{64}$"
MAX_DECLARED_BYTES = 50 * 1024 * 1024 * 1024
# Benchmark timestamps are limited to one day and frame indices/counts to ten
# million.  These finite bounds keep interpolation and report statistics away
# from Python float conversion overflow while leaving practical race videos far
# below the limit.
MAX_BENCHMARK_TIMESTAMP_MS = 86_400_000
MAX_BENCHMARK_FRAME_COUNT = 10_000_000
MAX_SUBJECT_OBSERVATIONS = 100_000
# This is deliberately much larger than ordinary normalized detections, but it
# prevents IEEE-754 subnormal dimensions from producing a zero-area box.
MIN_NORMALIZED_BOX_AREA = 1e-12
CONTROL_CHARACTER_LIMIT = 0x20
DELETE_CONTROL_CHARACTER = 0x7F


def _contains_control_character(value: str) -> bool:
    return any(
        ord(character) < CONTROL_CHARACTER_LIMIT
        or ord(character) == DELETE_CONTROL_CHARACTER
        for character in value
    )


def _safe_free_form_identifier(value: str) -> str:
    if _contains_control_character(value):
        raise ValueError("free-form identifier contains a control character")
    if "/" in value or "\\" in value:
        raise ValueError("free-form identifier contains a path separator")
    if re.search(r"(?i)(?:[a-z][a-z0-9+.-]*://|www\.)", value):
        raise ValueError("free-form identifier must not be URL-shaped")
    return value


SafeFreeFormIdentifier = Annotated[
    str,
    StringConstraints(min_length=1, max_length=128, strict=True),
    AfterValidator(_safe_free_form_identifier),
]
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

# Subject-observation contracts are deliberately colocated with the media
# contract: both are wire contracts owned by this service, while benchmark
# calculations live in ``benchmark.py``.
SUBJECT_CONTRACT_VERSION: Literal["subject-observation.v1"] = "subject-observation.v1"
BENCHMARK_CONTRACT_VERSION: Literal["subject-benchmark.v1"] = "subject-benchmark.v1"
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
        if self.width * self.height < MIN_NORMALIZED_BOX_AREA:
            raise ValueError("box area is below the normalized minimum")
        return self


class SubjectProvenance(StrictContract):
    provider: SafeFreeFormIdentifier
    model: SafeFreeFormIdentifier
    model_version: SafeFreeFormIdentifier = Field(alias="modelVersion")
    pipeline_version: SafeFreeFormIdentifier = Field(alias="pipelineVersion")
    configuration_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="configurationDigest")
    model_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="modelDigest")
    identity_confidence_threshold: float = Field(
        alias="identityConfidenceThreshold", ge=0.0, le=1.0, strict=True
    )
    confidence_calibration: SafeFreeFormIdentifier = Field(
        alias="confidenceCalibration"
    )


class SubjectObservation(StrictContract):
    timestamp_ms: int = Field(
        alias="timestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    frame_index: int = Field(
        alias="frameIndex", ge=0, lt=MAX_BENCHMARK_FRAME_COUNT, strict=True
    )
    box: NormalizedBox
    center: NormalizedPoint
    visibility: Literal["visible", "occluded", "uncertain"]
    identity_confidence: float = Field(
        alias="identityConfidence", ge=0.0, le=1.0, strict=True
    )
    origin: Literal["detected"]
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
    start_timestamp_ms: int = Field(
        alias="startTimestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    end_timestamp_ms: int = Field(
        alias="endTimestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    reason: Literal["ambiguous-identity", "occluded", "missing"]

    @model_validator(mode="after")
    def ordered(self) -> "TrackingGap":
        if self.end_timestamp_ms <= self.start_timestamp_ms:
            raise ValueError("tracking gap must have positive duration")
        return self


class AcceptedSubjectObservations(StrictContract):
    contract_version: Literal["subject-observation.v1"] = Field(alias="contractVersion")
    outcome: Literal["accepted"]
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    observations: tuple[SubjectObservation, ...] = Field(
        min_length=1, max_length=MAX_SUBJECT_OBSERVATIONS, strict=False
    )
    gaps: tuple[TrackingGap, ...] = Field(
        default=(), max_length=MAX_SUBJECT_OBSERVATIONS, strict=False
    )

    @model_validator(mode="after")
    def observations_are_ordered(self) -> "AcceptedSubjectObservations":
        if any(
            current.timestamp_ms <= previous.timestamp_ms
            or current.frame_index <= previous.frame_index
            for previous, current in zip(
                self.observations, self.observations[1:], strict=False
            )
        ):
            raise ValueError("observations must be strictly ordered")
        if any(
            current.start_timestamp_ms < previous.end_timestamp_ms
            for previous, current in zip(self.gaps, self.gaps[1:], strict=False)
        ):
            raise ValueError("tracking gaps must be ordered and non-overlapping")
        gap_index = 0
        for observation in self.observations:
            while (
                gap_index < len(self.gaps)
                and self.gaps[gap_index].end_timestamp_ms < observation.timestamp_ms
            ):
                gap_index += 1
            if (
                gap_index < len(self.gaps)
                and self.gaps[gap_index].start_timestamp_ms
                <= observation.timestamp_ms
                <= self.gaps[gap_index].end_timestamp_ms
            ):
                raise ValueError("tracking gaps must not contain observations")
        return self


class RejectedSubjectObservations(StrictContract):
    contract_version: Literal["subject-observation.v1"] = Field(alias="contractVersion")
    outcome: Literal["rejected"]
    case_id: SafeFreeFormIdentifier | None = Field(alias="caseId")
    error: "SubjectSafeError"


type SubjectErrorCode = Literal[
    "INVALID_OBSERVATION",
    "INFERENCE_UNAVAILABLE",
    "INFERENCE_FAILED",
    "RESOURCE_LIMIT",
]
type SubjectErrorStage = Literal["request", "initialize", "track", "serialize"]
type SubjectErrorMessage = Literal[
    "observation contract rejected",
    "inference provider unavailable",
    "inference failed safely",
    "inference resource limit exceeded",
]


class SubjectSafeError(StrictContract):
    code: SubjectErrorCode
    stage: SubjectErrorStage
    message: SubjectErrorMessage

    @model_validator(mode="after")
    def fields_are_canonical(self) -> "SubjectSafeError":
        expected = {
            "INVALID_OBSERVATION": ("request", "observation contract rejected"),
            "INFERENCE_UNAVAILABLE": (
                "initialize",
                "inference provider unavailable",
            ),
            "INFERENCE_FAILED": ("track", "inference failed safely"),
            "RESOURCE_LIMIT": ("serialize", "inference resource limit exceeded"),
        }[self.code]
        if (self.stage, self.message) != expected:
            raise ValueError("subject error fields must be canonical")
        return self


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
    timestamp_ms: int = Field(
        alias="timestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    frame_index: int = Field(
        alias="frameIndex", ge=0, lt=MAX_BENCHMARK_FRAME_COUNT, strict=True
    )
    identity: SafeFreeFormIdentifier
    box: NormalizedBox


class CorpusRecording(StrictContract):
    recording_id: SafeFreeFormIdentifier = Field(alias="recordingId")
    checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="checksumSha256")
    byte_count: int = Field(alias="byteCount", gt=0, strict=True)
    duration_ms: int = Field(
        alias="durationMs", gt=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    decoded_frame_count: int = Field(
        alias="decodedFrameCount", gt=0, le=MAX_BENCHMARK_FRAME_COUNT, strict=True
    )
    width: int = Field(gt=0, strict=True)
    height: int = Field(gt=0, strict=True)
    video_codec: SafeFreeFormIdentifier = Field(alias="videoCodec")
    container_formats: tuple[SafeFreeFormIdentifier, ...] = Field(
        alias="containerFormats", min_length=1, max_length=8, strict=False
    )
    average_frame_rate: RationalValue = Field(alias="averageFrameRate")

    @model_validator(mode="after")
    def average_frame_rate_is_positive(self) -> "CorpusRecording":
        if self.average_frame_rate.numerator <= 0:
            raise ValueError("average frame rate must be positive")
        return self


class BenchmarkCase(StrictContract):
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    recording_id: SafeFreeFormIdentifier = Field(alias="recordingId")
    window_start_ms: int = Field(
        alias="windowStartMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    window_end_ms: int = Field(
        alias="windowEndMs", gt=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
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
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="dockerImageDigest")
    python_lockfile_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="pythonLockfileDigest")
    ffmpeg_version: SafeFreeFormIdentifier = Field(alias="ffmpegVersion")
    model_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="modelDigest")
    provider: SafeFreeFormIdentifier
    model: SafeFreeFormIdentifier
    model_version: SafeFreeFormIdentifier = Field(alias="modelVersion")
    pipeline_version: SafeFreeFormIdentifier = Field(alias="pipelineVersion")
    configuration_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="configurationDigest")
    identity_confidence_threshold: float = Field(
        alias="identityConfidenceThreshold", ge=0.0, le=1.0, strict=True
    )
    confidence_calibration: SafeFreeFormIdentifier = Field(
        alias="confidenceCalibration"
    )
    identity_match_iou_threshold: float = Field(
        alias="identityMatchIouThreshold", gt=0.0, le=1.0, strict=True
    )
    identity_annotation_tolerance_ms: int = Field(
        alias="identityAnnotationToleranceMs", ge=0, le=1_000, strict=True
    )
    maximum_observation_interval_ms: int = Field(
        alias="maximumObservationIntervalMs", gt=0, le=10_000, strict=True
    )
    pass_match_tolerance_ms: int = Field(
        alias="passMatchToleranceMs", ge=0, le=10_000, strict=True
    )
    ambiguity_gap_coverage_tolerance_ms: int = Field(
        alias="ambiguityGapCoverageToleranceMs", ge=0, le=10_000, strict=True
    )


class CorpusRecordingManifest(StrictContract):
    contract_version: Literal["subject-benchmark.v1"] = Field(alias="contractVersion")
    corpus_id: SafeFreeFormIdentifier = Field(alias="corpusId")
    recordings: tuple[CorpusRecording, ...] = Field(
        min_length=1, max_length=100, strict=False
    )

    @model_validator(mode="after")
    def recording_ids_are_unique(self) -> "CorpusRecordingManifest":
        if len({item.recording_id for item in self.recordings}) != len(self.recordings):
            raise ValueError("benchmark recording IDs must be unique")
        return self


class CorpusManifest(CorpusRecordingManifest):
    cases: tuple[BenchmarkCase, ...] = Field(min_length=1, max_length=100, strict=False)
    required_coverage: float = Field(
        default=0.8, alias="requiredCoverage", ge=0.8, le=1.0, strict=True
    )
    pass_match_tolerance_ms: int = Field(
        default=500, alias="passMatchToleranceMs", ge=0, le=10_000, strict=True
    )
    frame_timestamp_tolerance_ms: int = Field(
        alias="frameTimestampToleranceMs", ge=0, strict=True
    )
    provenance: BenchmarkProvenance

    @model_validator(mode="after")
    def case_ids_are_unique(self) -> "CorpusManifest":
        if len({case.case_id for case in self.cases}) != len(self.cases):
            raise ValueError("benchmark case IDs must be unique")
        recording_ids = {recording.recording_id for recording in self.recordings}
        recordings = {
            recording.recording_id: recording for recording in self.recordings
        }
        if any(case.recording_id not in recording_ids for case in self.cases):
            raise ValueError("benchmark case references an unknown recording")
        if any(
            case.window_end_ms > recordings[case.recording_id].duration_ms
            for case in self.cases
            if case.recording_id in recordings
        ):
            raise ValueError("benchmark case window exceeds recording duration")
        return self


class GroundTruthPass(StrictContract):
    pass_id: SafeFreeFormIdentifier = Field(alias="passId")
    corner_id: SafeFreeFormIdentifier = Field(alias="cornerId")
    entry_timestamp_ms: int = Field(
        alias="entryTimestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    exit_timestamp_ms: int = Field(
        alias="exitTimestampMs", gt=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )

    @model_validator(mode="after")
    def ordered(self) -> "GroundTruthPass":
        if self.exit_timestamp_ms <= self.entry_timestamp_ms:
            raise ValueError("ground-truth pass must be ordered")
        return self


class SubjectIdentityAnnotation(StrictContract):
    timestamp_ms: int = Field(
        alias="timestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    frame_index: int = Field(
        alias="frameIndex", ge=0, lt=MAX_BENCHMARK_FRAME_COUNT, strict=True
    )
    box: NormalizedBox


class GroundTruthCase(StrictContract):
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    subject_identity: SafeFreeFormIdentifier = Field(alias="subjectIdentity")
    ambiguous_spans: tuple[TrackingGap, ...] = Field(
        default=(), alias="ambiguousSpans", max_length=100_000, strict=False
    )
    identity_annotations: tuple[SubjectIdentityAnnotation, ...] = Field(
        alias="identityAnnotations", min_length=1, max_length=100_000, strict=False
    )
    gates: Annotated[
        dict[
            SafeFreeFormIdentifier,
            CornerGates,
        ],
        Field(min_length=1, max_length=256),
    ]
    passes: tuple[GroundTruthPass, ...] = Field(
        default=(), max_length=10_000, strict=False
    )

    @model_validator(mode="after")
    def pass_corners_exist(self) -> "GroundTruthCase":
        if any(item.corner_id not in self.gates for item in self.passes):
            raise ValueError("ground-truth pass references an unknown corner")
        if len({item.pass_id for item in self.passes}) != len(self.passes):
            raise ValueError("ground-truth pass IDs must be unique")
        if any(
            current.entry_timestamp_ms <= previous.entry_timestamp_ms
            for previous, current in zip(self.passes, self.passes[1:], strict=False)
        ):
            raise ValueError("ground-truth passes must be strictly ordered")
        if any(
            current.timestamp_ms <= previous.timestamp_ms
            or current.frame_index <= previous.frame_index
            for previous, current in zip(
                self.identity_annotations,
                self.identity_annotations[1:],
                strict=False,
            )
        ):
            raise ValueError("identity annotations must be strictly ordered")
        if any(
            current.start_timestamp_ms < previous.end_timestamp_ms
            for previous, current in zip(
                self.ambiguous_spans, self.ambiguous_spans[1:], strict=False
            )
        ):
            raise ValueError("ambiguous spans must be ordered and non-overlapping")
        return self


class GroundTruth(StrictContract):
    contract_version: Literal["subject-benchmark.v1"] = Field(alias="contractVersion")
    corpus_id: SafeFreeFormIdentifier = Field(alias="corpusId")
    cases: tuple[GroundTruthCase, ...] = Field(
        min_length=1, max_length=100, strict=False
    )

    @model_validator(mode="after")
    def case_ids_are_unique(self) -> "GroundTruth":
        if len({case.case_id for case in self.cases}) != len(self.cases):
            raise ValueError("ground-truth case IDs must be unique")
        return self


class CoverageMetrics(StrictContract):
    eligible_passes: int = Field(alias="eligiblePasses", ge=0, strict=True)
    ground_truth_passes: int = Field(alias="groundTruthPasses", ge=0, strict=True)
    ratio: float = Field(ge=0.0, le=1.0, strict=True)


class GapMetrics(StrictContract):
    timely: int = Field(ge=0, strict=True)
    missed: int = Field(ge=0, strict=True)
    premature: int = Field(ge=0, strict=True)


class IdentityMetrics(StrictContract):
    unflagged_switches: int = Field(alias="unflaggedSwitches", ge=0, strict=True)


class GateTimingMetrics(StrictContract):
    count: int = Field(ge=0, strict=True)
    mean_ms: float | None = Field(alias="meanMs", strict=True, allow_inf_nan=False)
    median_ms: float | None = Field(alias="medianMs", strict=True, allow_inf_nan=False)
    max_absolute_ms: float | None = Field(
        alias="maxAbsoluteMs", ge=0.0, strict=True, allow_inf_nan=False
    )


class BenchmarkReport(StrictContract):
    contract_version: Literal["subject-benchmark.v1"] = Field(alias="contractVersion")
    corpus_id: SafeFreeFormIdentifier = Field(alias="corpusId")
    provenance: BenchmarkProvenance
    passed: bool
    coverage: CoverageMetrics
    gaps: GapMetrics
    identity: IdentityMetrics
    timing: GateTimingMetrics
