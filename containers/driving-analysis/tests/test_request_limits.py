import json
from typing import cast

import pytest
from starlette.types import Message, Receive, Scope, Send

from driving_analysis_service.request_limits import (
    RequestBodyLimitMiddleware,
    RequestBodyTooLargeError,
    _declared_body_is_too_large,
)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _scope(
    scope_type: str = "http",
    headers: list[tuple[bytes, bytes]] | None = None,
    path: str = "/v1/media/probe",
) -> Scope:
    return cast(
        "Scope",
        {
            "type": scope_type,
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "server": ("test", 80),
            "client": ("test", 1),
            "headers": headers or [],
        },
    )


def _receive(message: Message) -> Receive:
    async def receive() -> Message:
        return message

    return receive


def _send_collector(messages: list[Message]) -> Send:
    async def send(message: Message) -> None:
        messages.append(message)

    return send


@pytest.mark.anyio
async def test_middleware_passes_non_http_scope_through() -> None:
    called = False

    async def app(_scope: Scope, _receive: Receive, _send: Send) -> None:
        nonlocal called
        called = True

    middleware = RequestBodyLimitMiddleware(app, max_bytes=1)
    await middleware(
        _scope("websocket"),
        _receive({"type": "websocket.disconnect", "code": 1000}),
        _send_collector([]),
    )

    assert called is True


def test_declared_body_limit_handles_missing_and_malformed_values() -> None:
    assert _declared_body_is_too_large(_scope(), 1) is False
    assert (
        _declared_body_is_too_large(
            _scope(headers=[(b"content-length", b"invalid")]),
            1,
        )
        is True
    )


def _json_body(messages: list[Message]) -> dict[str, object]:
    return cast("dict[str, object]", json.loads(cast("bytes", messages[-1]["body"])))


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("path", "contract_version"),
    [
        ("/v1/media/probe", "race-video-validation.v1"),
        ("/v1/stages/prepare", "subject-tracking.v1"),
        ("/v1/stages/render", "corner-render.v1"),
    ],
)
async def test_middleware_limits_streamed_body_without_content_length(
    path: str,
    contract_version: str,
) -> None:
    async def app(_scope: Scope, receive: Receive, _send: Send) -> None:
        await receive()

    messages: list[Message] = []
    middleware = RequestBodyLimitMiddleware(app, max_bytes=1)
    await middleware(
        _scope(path=path),
        _receive({"type": "http.request", "body": b"too large"}),
        _send_collector(messages),
    )

    assert messages[0]["type"] == "http.response.start"
    assert messages[0]["status"] == 413
    assert _json_body(messages)["contractVersion"] == contract_version


@pytest.mark.anyio
async def test_middleware_uses_render_contract_for_declared_oversized_body() -> None:
    async def unexpected_app(_scope: Scope, _receive: Receive, _send: Send) -> None:
        msg = "oversized request reached the application"
        raise AssertionError(msg)

    messages: list[Message] = []
    middleware = RequestBodyLimitMiddleware(unexpected_app, max_bytes=1)
    await middleware(
        _scope(
            headers=[(b"content-length", b"2")],
            path="/v1/stages/render",
        ),
        _receive({"type": "http.request", "body": b"{}"}),
        _send_collector(messages),
    )

    assert messages[0]["status"] == 413
    assert _json_body(messages) == {
        "contractVersion": "corner-render.v1",
        "correlationId": None,
        "outcome": "rejected",
        "caseId": None,
        "error": {
            "code": "INVALID_REQUEST",
            "stage": "request",
            "message": "render request rejected",
        },
    }


@pytest.mark.anyio
async def test_middleware_passes_non_body_messages_to_application() -> None:
    observed: Message | None = None

    async def app(_scope: Scope, receive: Receive, send: Send) -> None:
        nonlocal observed
        observed = await receive()
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    messages: list[Message] = []
    middleware = RequestBodyLimitMiddleware(app, max_bytes=1)
    disconnect: Message = {"type": "http.disconnect"}
    await middleware(_scope(), _receive(disconnect), _send_collector(messages))

    assert observed == disconnect
    assert messages[0]["status"] == 204


@pytest.mark.anyio
async def test_middleware_does_not_replace_a_started_response() -> None:
    async def app(_scope: Scope, receive: Receive, send: Send) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await receive()

    middleware = RequestBodyLimitMiddleware(app, max_bytes=1)

    with pytest.raises(RequestBodyTooLargeError):
        await middleware(
            _scope(),
            _receive({"type": "http.request", "body": b"too large"}),
            _send_collector([]),
        )
