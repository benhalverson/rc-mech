from driving_analysis_service.errors import MediaValidationError
from driving_analysis_service.inference import (
    InferenceFailureError,
    InferenceUnavailableError,
)
from driving_analysis_service.processes import (
    ProcessOutputLimitError,
    ProcessTimeoutError,
)
from driving_analysis_service.tracking_artifacts import (
    ArtifactConflictError,
    InvalidArtifactError,
)
from driving_analysis_service.tracking_contracts import (
    PROCESSING_CONTRACT_VERSION,
    PROCESSING_ERROR_FIELDS,
    PrepareStageRequest,
    ProcessingErrorCode,
    ProcessingErrorStage,
    ProcessingRejected,
    ProcessingSafeError,
    TrackStageRequest,
)


def preparation_error_code(error: Exception) -> ProcessingErrorCode:
    if isinstance(error, ArtifactConflictError):
        return "ARTIFACT_CONFLICT"
    if isinstance(error, ProcessTimeoutError):
        return "PROCESS_TIMEOUT"
    if isinstance(error, MediaValidationError):
        if error.code in {"STAGED_MEDIA_NOT_FOUND", "STAGED_MEDIA_MISMATCH"}:
            return "MEDIA_UNAVAILABLE"
        if error.code == "PROCESS_TIMEOUT":
            return "PROCESS_TIMEOUT"
    if isinstance(error, ProcessOutputLimitError):
        return "RESOURCE_LIMIT"
    return "PREPARATION_FAILED"


def tracking_error_code(error: Exception) -> ProcessingErrorCode:
    mappings: tuple[tuple[type[Exception], ProcessingErrorCode], ...] = (
        (ArtifactConflictError, "ARTIFACT_CONFLICT"),
        (InferenceUnavailableError, "INFERENCE_UNAVAILABLE"),
        (InvalidArtifactError, "MEDIA_UNAVAILABLE"),
        (ProcessTimeoutError, "PROCESS_TIMEOUT"),
        (ProcessOutputLimitError, "RESOURCE_LIMIT"),
        (InferenceFailureError, "INFERENCE_FAILED"),
    )
    return next(
        (code for error_type, code in mappings if isinstance(error, error_type)),
        "INFERENCE_FAILED",
    )


def rejected(
    request: PrepareStageRequest | TrackStageRequest,
    code: ProcessingErrorCode,
) -> ProcessingRejected:
    timeout_stage: ProcessingErrorStage = (
        "track" if isinstance(request, TrackStageRequest) else "prepare"
    )
    stage, message = PROCESSING_ERROR_FIELDS[code]
    if code == "PROCESS_TIMEOUT":
        stage = timeout_stage
    return ProcessingRejected(
        contractVersion=PROCESSING_CONTRACT_VERSION,
        correlationId=request.correlation_id,
        outcome="rejected",
        caseId=request.case_id,
        error=ProcessingSafeError(code=code, stage=stage, message=message),
    )
