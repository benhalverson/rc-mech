import os
import threading

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from driving_analysis_service.contracts import (
    CONTRACT_VERSION,
    SERVICE_NAME,
    HealthResponse,
    MediaValidationRequest,
    RejectedValidationResponse,
    SafeError,
    ValidationResponse,
)
from driving_analysis_service.media import MediaValidationService
from driving_analysis_service.preparation import RaceWindowPreparationService
from driving_analysis_service.rendering import CornerRenderService
from driving_analysis_service.rendering_contracts import (
    RenderSafeError,
    RenderStageRejected,
    RenderStageRequest,
    RenderStageResponse,
)
from driving_analysis_service.request_limits import RequestBodyLimitMiddleware
from driving_analysis_service.settings import ServiceSettings
from driving_analysis_service.tracking_contracts import (
    PROCESSING_CONTRACT_VERSION,
    PrepareStageRequest,
    PrepareStageResponse,
    ProcessingRejected,
    ProcessingSafeError,
)


def create_app(
    settings: ServiceSettings | None = None,
) -> FastAPI:
    resolved_settings = settings or ServiceSettings.from_environment()
    service = MediaValidationService(resolved_settings)
    processing_admission = threading.BoundedSemaphore(
        resolved_settings.limits.max_concurrent_processing
    )
    preparation_service = RaceWindowPreparationService(
        resolved_settings,
        processing_admission,
    )
    rendering_service = CornerRenderService(resolved_settings, processing_admission)

    application = FastAPI(
        title="RC Mech driving-analysis media service",
        version=CONTRACT_VERSION,
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
    )
    application.add_middleware(
        RequestBodyLimitMiddleware,
        max_bytes=resolved_settings.limits.max_request_body_bytes,
    )

    @application.exception_handler(RequestValidationError)
    async def request_validation_error(
        request: Request,
        _error: RequestValidationError,
    ) -> JSONResponse:
        if request.url.path == "/v1/stages/render":
            render_response = RenderStageRejected(
                contractVersion="corner-render.v1",
                correlationId=None,
                outcome="rejected",
                caseId=None,
                error=RenderSafeError(
                    code="INVALID_REQUEST",
                    stage="request",
                    message="render request rejected",
                ),
            )
            return JSONResponse(
                status_code=422,
                content=render_response.model_dump(mode="json", by_alias=True),
            )
        if request.url.path == "/v1/stages/prepare":
            processing_response = ProcessingRejected(
                contractVersion=PROCESSING_CONTRACT_VERSION,
                correlationId=None,
                outcome="rejected",
                caseId=None,
                error=ProcessingSafeError(
                    code="INVALID_REQUEST",
                    stage="request",
                    message="processing request rejected",
                ),
            )
            return JSONResponse(
                status_code=422,
                content=processing_response.model_dump(mode="json", by_alias=True),
            )
        response = RejectedValidationResponse(
            contractVersion=CONTRACT_VERSION,
            correlationId=None,
            outcome="rejected",
            error=SafeError(
                code="INVALID_REQUEST",
                stage="request",
                message="The request does not match the versioned contract.",
            ),
        )
        return JSONResponse(
            status_code=422,
            content=response.model_dump(mode="json", by_alias=True),
        )

    @application.get(
        "/health",
        response_model=HealthResponse,
        responses={503: {"model": RejectedValidationResponse}},
    )
    def health() -> HealthResponse | JSONResponse:
        if not _is_ready(resolved_settings):
            response = RejectedValidationResponse(
                contractVersion=CONTRACT_VERSION,
                correlationId=None,
                outcome="rejected",
                error=SafeError(
                    code="SERVICE_UNAVAILABLE",
                    stage="request",
                    message="The media validation service is unavailable.",
                ),
            )
            return JSONResponse(
                status_code=503,
                content=response.model_dump(mode="json", by_alias=True),
            )
        return HealthResponse(
            contractVersion=CONTRACT_VERSION,
            service=SERVICE_NAME,
            status="ready",
        )

    @application.post(
        "/v1/media/probe",
        responses={422: {"model": RejectedValidationResponse}},
    )
    def validate_media(request: MediaValidationRequest) -> ValidationResponse:
        return service.validate(request)

    @application.post(
        "/v1/stages/prepare",
        responses={422: {"model": ProcessingRejected}},
    )
    def prepare_race_window(request: PrepareStageRequest) -> PrepareStageResponse:
        return preparation_service.prepare(request)

    @application.post(
        "/v1/stages/render",
        responses={422: {"model": RenderStageRejected}},
    )
    def render_corner(request: RenderStageRequest) -> RenderStageResponse:
        return rendering_service.render(request)

    return application


def _is_ready(settings: ServiceSettings) -> bool:
    try:
        settings.prepare_roots()
    except OSError:
        return False
    executables = (settings.ffprobe_executable, settings.ffmpeg_executable)
    roots = (settings.staging_root, settings.work_root, settings.artifact_root)
    return all(
        executable.is_file() and os.access(executable, os.X_OK)
        for executable in executables
    ) and all(
        root.is_dir() and os.access(root, os.R_OK | os.W_OK | os.X_OK) for root in roots
    )


app = create_app()
