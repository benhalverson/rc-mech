from collections.abc import Awaitable, Callable

from fastapi.responses import JSONResponse
from starlette.types import Message, Receive, Scope, Send

from driving_analysis_service.contracts import (
    CONTRACT_VERSION,
    RejectedValidationResponse,
    SafeError,
)
from driving_analysis_service.rendering_contracts import (
    RENDER_CONTRACT_VERSION,
    RenderSafeError,
    RenderStageRejected,
)
from driving_analysis_service.tracking_contracts import (
    PROCESSING_CONTRACT_VERSION,
    ProcessingRejected,
    ProcessingSafeError,
)

AsgiApplication = Callable[[Scope, Receive, Send], Awaitable[None]]


class RequestBodyTooLargeError(RuntimeError):
    """An HTTP request exceeded the internal JSON body limit."""


class RequestBodyLimitMiddleware:
    def __init__(self, app: AsgiApplication, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if _declared_body_is_too_large(scope, self.max_bytes):
            await _send_too_large(scope, receive, send)
            return

        received_bytes = 0
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > self.max_bytes:
                    raise RequestBodyTooLargeError
            return message

        async def observed_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, observed_send)
        except RequestBodyTooLargeError:
            if response_started:
                raise
            await _send_too_large(scope, receive, send)


def _declared_body_is_too_large(scope: Scope, max_bytes: int) -> bool:
    headers = dict(scope.get("headers", ()))
    raw_content_length = headers.get(b"content-length")
    if raw_content_length is None:
        return False
    try:
        return int(raw_content_length) > max_bytes
    except ValueError:
        return True


async def _send_too_large(scope: Scope, receive: Receive, send: Send) -> None:
    await JSONResponse(
        status_code=413,
        content=_too_large_content(scope),
    )(scope, receive, send)


def _too_large_content(scope: Scope) -> dict[str, object]:
    path = scope.get("path", "")
    if path == "/v1/stages/render":
        response = RenderStageRejected(
            contractVersion=RENDER_CONTRACT_VERSION,
            correlationId=None,
            outcome="rejected",
            caseId=None,
            error=RenderSafeError(
                code="INVALID_REQUEST",
                stage="request",
                message="render request rejected",
            ),
        )
        return response.model_dump(mode="json", by_alias=True)
    if path.startswith("/v1/stages/"):
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
        return processing_response.model_dump(mode="json", by_alias=True)
    validation_response = RejectedValidationResponse(
        contractVersion=CONTRACT_VERSION,
        correlationId=None,
        outcome="rejected",
        error=SafeError(
            code="INVALID_REQUEST",
            stage="request",
            message="The request body exceeds the configured limit.",
        ),
    )
    return validation_response.model_dump(mode="json", by_alias=True)
