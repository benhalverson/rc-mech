import threading
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Annotated

from driving_analysis_service.request_limits import RequestBodyLimitMiddleware
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from chassis_notes_gpu_worker.contracts import (
    CancelCommand,
    ExecutionIdentity,
    HealthResponse,
    JobStatus,
    StatusQuery,
    TrackingJobSubmission,
    TransferGrantCommand,
)
from chassis_notes_gpu_worker.executor import Sam31TrackingExecutor
from chassis_notes_gpu_worker.jobs import JobManager, JobRejectedError
from chassis_notes_gpu_worker.settings import WorkerSettings

ReadyCheck = Callable[[], bool]


def create_app(  # noqa: C901 - route registration is the application composition root
    settings: WorkerSettings | None = None,
    manager: JobManager | None = None,
    ready: ReadyCheck | None = None,
) -> FastAPI:
    resolved_settings = settings or WorkerSettings.from_environment()
    if manager is None:
        executor = Sam31TrackingExecutor(
            resolved_settings.installed_profile,
            resolved_settings.checkpoint_path,
        )
        manager = JobManager(resolved_settings, executor)
        ready = executor.ready
    readiness = ready or (lambda: True)
    stop_watchdog = threading.Event()

    @asynccontextmanager
    async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
        watchdog = threading.Thread(
            target=_watchdog_loop,
            args=(manager, stop_watchdog),
            daemon=True,
        )
        watchdog.start()
        try:
            yield
        finally:
            stop_watchdog.set()
            watchdog.join(timeout=2)

    application = FastAPI(
        title="Chassis Notes private Driving-analysis GPU worker",
        version="tracking-provider.v1",
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    application.add_middleware(RequestBodyLimitMiddleware, max_bytes=16 * 1024)

    @application.exception_handler(RequestValidationError)
    async def validation_error(
        _request: Request,
        _error: RequestValidationError,
    ) -> JSONResponse:
        return _error_response(
            "INVALID_REQUEST",
            "request does not match the execution contract",
            422,
        )

    @application.exception_handler(JobRejectedError)
    async def job_rejected(
        _request: Request,
        error: JobRejectedError,
    ) -> JSONResponse:
        status = {
            "GPU_CAPACITY_BUSY": 409,
            "PROFILE_UNAVAILABLE": 503,
            "JOB_NOT_FOUND": 404,
            "AUTHORITY_MISMATCH": 409,
            "TRANSFER_FAILED": 409,
        }.get(error.error.code, 409)
        return JSONResponse(
            status_code=status,
            content={
                "contractVersion": "tracking-provider.v1",
                "outcome": "rejected",
                "error": error.error.model_dump(mode="json", by_alias=True),
            },
        )

    @application.get("/health")
    def health() -> HealthResponse:
        is_ready = readiness()
        return HealthResponse(
            contractVersion="tracking-provider.v1",
            service="driving-analysis-gpu",
            status="ready" if is_ready else "unavailable",
            resolvedProfileDigest=resolved_settings.installed_profile.digest,
            capacity=manager.capacity,
        )

    @application.post("/v1/jobs", status_code=202)
    def submit_job(submission: TrackingJobSubmission) -> JobStatus:
        return manager.submit(submission)

    @application.get("/v1/jobs/{segment_id}")
    def job_status(
        segment_id: str,
        query: Annotated[StatusQuery, Query()],
    ) -> JobStatus:
        identity = ExecutionIdentity(
            runId=query.run_id,
            segmentId=segment_id,
            attemptId=query.attempt_id,
            leaseId=query.lease_id,
            fencingToken=query.fencing_token,
            specificationDigest=query.specification_digest,
            profileDigest=query.profile_digest,
        )
        return manager.status(identity)

    @application.post(
        "/v1/jobs/{segment_id}/transfer-grants",
        status_code=202,
    )
    def deliver_transfer_grant(
        segment_id: str,
        command: TransferGrantCommand,
    ) -> JobStatus:
        if segment_id != command.segment_id:
            return manager.status(command.model_copy(update={"segment_id": segment_id}))
        return manager.deliver_grant(command)

    @application.post(
        "/v1/jobs/{segment_id}/cancel",
        status_code=202,
    )
    def cancel_job(segment_id: str, command: CancelCommand) -> JobStatus:
        if segment_id != command.segment_id:
            return manager.status(command.model_copy(update={"segment_id": segment_id}))
        return manager.cancel(command)

    return application


def _watchdog_loop(manager: JobManager, stopped: threading.Event) -> None:
    while not stopped.wait(1):
        manager.expire_stale()
        manager.cleanup_expired()


def _error_response(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={
            "contractVersion": "tracking-provider.v1",
            "outcome": "rejected",
            "error": {"code": code, "message": message},
        },
    )
