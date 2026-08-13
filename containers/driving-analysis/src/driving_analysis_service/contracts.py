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
    provider: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    model: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    model_version: Annotated[str, StringConstraints(min_length=1, max_length=128)] = (
        Field(alias="modelVersion")
    )
    pipeline_version: Annotated[str, StringConstraints(min_length=1, max_length=64)] = (
        Field(alias="pipelineVersion")
    )
    configuration_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="configurationDigest")
    model_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="modelDigest")
    identity_confidence_threshold: float = Field(
        alias="identityConfidenceThreshold", ge=0.0, le=1.0, strict=True
    )
    confidence_calibration: Annotated[
        str, StringConstraints(min_length=1, max_length=128)
    ] = Field(alias="confidenceCalibration")


class SubjectObservation(StrictContract):
    timestamp_ms: int = Field(alias="timestampMs", ge=0, strict=True)
    frame_index: int = Field(alias="frameIndex", ge=0, strict=True)
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
    gaps: tuple[TrackingGap, ...] = Field(default=(), max_length=100_000, strict=False)

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
    case_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] | None = (
        Field(alias="caseId")
    )
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
    frame_index: int = Field(alias="frameIndex", ge=0, strict=True)
    identity: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    box: NormalizedBox


class CorpusRecording(StrictContract):
    recording_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = (
        Field(alias="recordingId")
    )
    checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="checksumSha256")
    byte_count: int = Field(alias="byteCount", gt=0, strict=True)
    duration_ms: int = Field(alias="durationMs", gt=0, strict=True)
    width: int = Field(gt=0, strict=True)
    height: int = Field(gt=0, strict=True)
    video_codec: Annotated[
        str, StringConstraints(min_length=1, max_length=32, strict=True)
    ] = Field(alias="videoCodec")
    container_formats: tuple[
        Annotated[str, StringConstraints(min_length=1, max_length=32)], ...
    ] = Field(alias="containerFormats", min_length=1, max_length=8, strict=False)
    average_frame_rate: RationalValue = Field(alias="averageFrameRate")


class BenchmarkCase(StrictContract):
    case_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="caseId"
    )
    recording_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = (
        Field(alias="recordingId")
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
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="dockerImageDigest")
    python_lockfile_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="pythonLockfileDigest")
    ffmpeg_version: Annotated[str, StringConstraints(min_length=1, max_length=64)] = (
        Field(alias="ffmpegVersion")
    )
    model_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="modelDigest")
    provider: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    model: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    model_version: Annotated[str, StringConstraints(min_length=1, max_length=128)] = (
        Field(alias="modelVersion")
    )
    pipeline_version: Annotated[str, StringConstraints(min_length=1, max_length=64)] = (
        Field(alias="pipelineVersion")
    )
    configuration_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="configurationDigest")
    identity_confidence_threshold: float = Field(
        alias="identityConfidenceThreshold", ge=0.0, le=1.0, strict=True
    )
    confidence_calibration: Annotated[
        str, StringConstraints(min_length=1, max_length=128)
    ] = Field(alias="confidenceCalibration")
    identity_match_iou_threshold: float = Field(
        alias="identityMatchIouThreshold", gt=0.0, le=1.0, strict=True
    )
    identity_annotation_tolerance_ms: int = Field(
        alias="identityAnnotationToleranceMs", ge=0, le=1_000, strict=True
    )


class CorpusRecordingManifest(StrictContract):
    contract_version: Literal["subject-benchmark.v1"] = Field(alias="contractVersion")
    corpus_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="corpusId"
    )
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
        default=500, alias="passMatchToleranceMs", ge=0, le=60_000, strict=True
    )
    provenance: BenchmarkProvenance

    @model_validator(mode="after")
    def case_ids_are_unique(self) -> "CorpusManifest":
        if len({case.case_id for case in self.cases}) != len(self.cases):
            raise ValueError("benchmark case IDs must be unique")
        recording_ids = {recording.recording_id for recording in self.recordings}
        if any(case.recording_id not in recording_ids for case in self.cases):
            raise ValueError("benchmark case references an unknown recording")
        return self


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


class SubjectIdentityAnnotation(StrictContract):
    timestamp_ms: int = Field(alias="timestampMs", ge=0, strict=True)
    frame_index: int = Field(alias="frameIndex", ge=0, strict=True)
    box: NormalizedBox


class GroundTruthCase(StrictContract):
    case_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="caseId"
    )
    subject_identity: Annotated[str, StringConstraints(min_length=1, max_length=64)] = (
        Field(alias="subjectIdentity")
    )
    ambiguous_spans: tuple[TrackingGap, ...] = Field(
        default=(), alias="ambiguousSpans", max_length=100_000, strict=False
    )
    identity_annotations: tuple[SubjectIdentityAnnotation, ...] = Field(
        alias="identityAnnotations", min_length=1, max_length=100_000, strict=False
    )
    gates: Annotated[
        dict[
            Annotated[str, StringConstraints(min_length=1, max_length=64)],
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
    corpus_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="corpusId"
    )
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
    mean_ms: float | None = Field(alias="meanMs")
    median_ms: float | None = Field(alias="medianMs")
    max_absolute_ms: float | None = Field(alias="maxAbsoluteMs", ge=0.0)


class BenchmarkReport(StrictContract):
    contract_version: Literal["subject-benchmark.v1"] = Field(alias="contractVersion")
    corpus_id: Annotated[str, StringConstraints(min_length=1, max_length=64)] = Field(
        alias="corpusId"
    )
    provenance: BenchmarkProvenance
    passed: bool
    coverage: CoverageMetrics
    gaps: GapMetrics
    identity: IdentityMetrics
    timing: GateTimingMetrics
