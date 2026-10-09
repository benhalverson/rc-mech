"""Provider-neutral observation evidence accepted by tracking and the hermetic
benchmark.

Model responsibilities (kept here to preserve generated schema descriptions):
SubjectProvenance: Pins model, pipeline, configuration, and confidence calibration
    to
    each observation.
SubjectObservation: Binds one detection/re-identification to source time, frame,
    normalized geometry, and provenance.
TrackingGap: Marks a closed ambiguous/missing interval that pass interpolation must
    not cross.
AcceptedSubjectObservations: Validates ordered observations and gaps for a case
    before
    benchmark evaluation.
RejectedSubjectObservations: Represents a safe case failure without fabricating
    accepted evidence.
SubjectSafeError: Enforces canonical code/stage/message combinations for observation
    failures.
"""
# ruff: noqa: EM101, TRY003

from typing import Annotated, Literal

from pydantic import (
    Field,
    StringConstraints,
    model_validator,
)

from driving_analysis_service.contract_primitives import (
    CENTER_TOLERANCE,
    MAX_BENCHMARK_FRAME_COUNT,
    MAX_BENCHMARK_TIMESTAMP_MS,
    MAX_SUBJECT_OBSERVATIONS,
    SHA256_PATTERN,
    ModelIdentifier,
    ProviderIdentifier,
    SafeFreeFormIdentifier,
    StrictContract,
)
from driving_analysis_service.geometry_contracts import (
    NormalizedBox,
    NormalizedPoint,
)


class InferenceProvenance(StrictContract):
    """Shared inference identity; flat aliases preserve versioned wire contracts."""

    provider: ProviderIdentifier
    model: ModelIdentifier
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


class SubjectProvenance(InferenceProvenance):
    """Inference identity attached to each Subject observation."""


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
    origin: Literal["detected", "user-reidentified-point", "user-reidentified-box"]
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
        for index, observation in enumerate(self.observations):
            if observation.origin == "detected":
                continue
            if index == 0 or not any(
                self.observations[index - 1].timestamp_ms < gap.start_timestamp_ms
                and gap.end_timestamp_ms < observation.timestamp_ms
                for gap in self.gaps
            ):
                raise ValueError("user re-identification must follow a tracking gap")
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
