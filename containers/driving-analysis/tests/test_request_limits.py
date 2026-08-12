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
) -> Scope:
    return cast(
        "Scope",
        {
            "type": scope_type,
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/v1/media/probe",
            "raw_path": b"/v1/media/probe",
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


@pytest.mark.anyio
async def test_middleware_limits_streamed_body_without_content_length() -> None:
    async def app(_scope: Scope, receive: Receive, _send: Send) -> None:
        await receive()

    messages: list[Message] = []
    middleware = RequestBodyLimitMiddleware(app, max_bytes=1)
    await middleware(
        _scope(),
        _receive({"type": "http.request", "body": b"too large"}),
        _send_collector(messages),
    )

    assert messages[0]["type"] == "http.response.start"
    assert messages[0]["status"] == 413


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
