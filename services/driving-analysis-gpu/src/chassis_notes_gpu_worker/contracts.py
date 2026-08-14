from typing import Annotated, Literal
from urllib.parse import urlsplit

from driving_analysis_service.contracts import (
    SHA256_PATTERN,
    StrictContract,
    UuidV4String,
)
from driving_analysis_service.tracking_contracts import (
    ObservationSegmentArtifact,
    TrackStageRequest,
)
from pydantic import Field, StringConstraints, model_validator

Sha256 = Annotated[str, StringConstraints(pattern=SHA256_PATTERN, strict=True)]
TransferUrl = Annotated[str, StringConstraints(min_length=1, max_length=8192)]

JobState = Literal[
    "transfer-grant-required",
    "transferring",
    "processing",
    "output-ready",
    "completed",
    "cancel-requested",
    "cancelled",
    "interrupted",
    "failed",
]
TransferRole = Literal["prepared-media", "frame-manifest", "observation-artifact"]


class ExecutionIdentity(StrictContract):
    run_id: UuidV4String = Field(alias="runId")
    segment_id: UuidV4String = Field(alias="segmentId")
    attempt_id: UuidV4String = Field(alias="attemptId")
    lease_id: UuidV4String = Field(alias="leaseId")
    fencing_token: int = Field(alias="fencingToken", ge=1, strict=True)
    specification_digest: Sha256 = Field(alias="specificationDigest")
    profile_digest: Sha256 = Field(alias="profileDigest")


class StatusQuery(StrictContract):
    run_id: UuidV4String = Field(alias="runId")
    attempt_id: UuidV4String = Field(alias="attemptId")
    lease_id: UuidV4String = Field(alias="leaseId")
    fencing_token: int = Field(alias="fencingToken", ge=1, strict=False)
    specification_digest: Sha256 = Field(alias="specificationDigest")
    profile_digest: Sha256 = Field(alias="profileDigest")


class TrackingJobSubmission(ExecutionIdentity):
    contract_version: Literal["tracking-provider.v1"] = Field(alias="contractVersion")
    tracking_request: TrackStageRequest = Field(alias="trackingRequest")

    @model_validator(mode="after")
    def segment_identity_matches(self) -> "TrackingJobSubmission":
        if self.tracking_request.observation_segment_id != self.segment_id:
            message = "Tracking request must use the submitted segment"
            raise ValueError(message)
        return self


class TransferRequest(StrictContract):
    transfer_request_id: UuidV4String = Field(alias="transferRequestId")
    role: TransferRole
    method: Literal["GET", "PUT"]

    @model_validator(mode="after")
    def role_matches_method(self) -> "TransferRequest":
        expected = "PUT" if self.role == "observation-artifact" else "GET"
        if self.method != expected:
            message = "Transfer role does not match method"
            raise ValueError(message)
        return self


class OutputArtifact(StrictContract):
    contract_version: Literal["tracking-artifact.v1"] = Field(alias="contractVersion")
    run_id: UuidV4String = Field(alias="runId")
    segment_id: UuidV4String = Field(alias="segmentId")
    attempt_id: UuidV4String = Field(alias="attemptId")
    lease_id: UuidV4String = Field(alias="leaseId")
    fencing_token: int = Field(alias="fencingToken", ge=1, strict=True)
    specification_digest: Sha256 = Field(alias="specificationDigest")
    profile_digest: Sha256 = Field(alias="profileDigest")
    segment: ObservationSegmentArtifact


class SafeJobError(StrictContract):
    code: Literal[
        "GPU_CAPACITY_BUSY",
        "PROFILE_UNAVAILABLE",
        "JOB_NOT_FOUND",
        "AUTHORITY_MISMATCH",
        "TRANSFER_FAILED",
        "TRACKING_FAILED",
        "JOB_INTERRUPTED",
        "INVALID_REQUEST",
    ]
    message: Literal[
        "GPU execution capacity is busy",
        "requested inference profile is unavailable",
        "Tracking job was not found",
        "Tracking authority does not match",
        "artifact transfer failed safely",
        "Tracking execution failed safely",
        "Tracking execution was interrupted",
        "request does not match the execution contract",
    ]


class JobStatus(ExecutionIdentity):
    contract_version: Literal["tracking-provider.v1"] = Field(alias="contractVersion")
    state: JobState
    resolved_profile_digest: Sha256 = Field(alias="resolvedProfileDigest")
    progress: int = Field(ge=0, le=99, strict=True)
    transfer_request: TransferRequest | None = Field(
        default=None, alias="transferRequest"
    )
    artifact: OutputArtifact | None = None
    error: SafeJobError | None = None


class TransferGrantCommand(ExecutionIdentity):
    contract_version: Literal["tracking-provider.v1"] = Field(alias="contractVersion")
    transfer_request_id: UuidV4String = Field(alias="transferRequestId")
    role: TransferRole
    method: Literal["GET", "PUT"]
    url: TransferUrl
    expires_at: int = Field(alias="expiresAt", gt=0, strict=True)

    @model_validator(mode="after")
    def grant_is_narrow_https(self) -> "TransferGrantCommand":
        expected = "PUT" if self.role == "observation-artifact" else "GET"
        parsed = urlsplit(self.url)
        if (
            self.method != expected
            or parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
        ):
            message = "Transfer grant must be a narrow HTTPS capability"
            raise ValueError(message)
        return self


class CancelCommand(ExecutionIdentity):
    contract_version: Literal["tracking-provider.v1"] = Field(alias="contractVersion")


class HealthResponse(StrictContract):
    contract_version: Literal["tracking-provider.v1"] = Field(alias="contractVersion")
    service: Literal["driving-analysis-gpu"]
    status: Literal["ready", "unavailable"]
    resolved_profile_digest: Sha256 = Field(alias="resolvedProfileDigest")
    capacity: Literal["available", "busy"]
