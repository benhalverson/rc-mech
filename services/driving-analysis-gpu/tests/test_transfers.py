import hashlib
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Self

import pytest

from chassis_notes_gpu_worker.transfers import (
    TransferClient,
    TransferFailureError,
    _https_url,
    _RejectRedirects,
    _write_all,
)


class _Response:
    def __init__(
        self,
        chunks: tuple[bytes, ...] = (),
        *,
        content_length: str | None = None,
        status: int = 200,
    ) -> None:
        self._chunks = list(chunks)
        self.headers = (
            {} if content_length is None else {"Content-Length": content_length}
        )
        self.status = status

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_error: object) -> None:
        return None

    def read(self, _size: int) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""


class _Opener:
    def __init__(
        self,
        response: _Response | None = None,
        error: BaseException | None = None,
    ) -> None:
        self.response = response
        self.error = error
        self.requests: list[tuple[urllib.request.Request, float]] = []

    def open(
        self,
        request: urllib.request.Request,
        *,
        timeout: float,
    ) -> _Response:
        self.requests.append((request, timeout))
        if self.error is not None:
            raise self.error
        assert self.response is not None
        return self.response


def _client(opener: _Opener) -> TransferClient:
    client = TransferClient()
    client._opener = opener
    return client


def test_redirects_are_rejected() -> None:
    handler = _RejectRedirects()

    assert (
        handler.redirect_request(
            urllib.request.Request("https://r2.example/source"),
            object(),
            302,
            "Found",
            object(),
            "https://r2.example/other",
        )
        is None
    )


def test_download_streams_to_an_atomic_destination(tmp_path: Path) -> None:
    value = b"prepared-media"
    opener = _Opener(_Response((value[:4], value[4:]), content_length=str(len(value))))
    destination = tmp_path / "prepared.track.mp4"

    _client(opener).download(
        "https://r2.example/object?signature=secret",
        destination,
        expected_bytes=len(value),
        expected_checksum=hashlib.sha256(value).hexdigest(),
        max_bytes=len(value),
        timeout_seconds=12.0,
        cancelled=lambda: False,
    )

    assert destination.read_bytes() == value
    assert not destination.with_suffix(".mp4.pending").exists()
    request, timeout = opener.requests[0]
    assert request.full_url == "https://r2.example/object?signature=secret"
    assert request.get_method() == "GET"
    assert timeout == 12.0


@pytest.mark.parametrize(
    ("response", "expected_bytes", "expected_checksum", "max_bytes", "cancelled"),
    [
        (
            _Response((b"abc",), content_length="4"),
            3,
            hashlib.sha256(b"abc").hexdigest(),
            3,
            lambda: False,
        ),
        (
            _Response((b"abc",), content_length="invalid"),
            3,
            hashlib.sha256(b"abc").hexdigest(),
            3,
            lambda: False,
        ),
        (_Response((b"abc",)), 3, hashlib.sha256(b"abc").hexdigest(), 2, lambda: False),
        (_Response((b"abc",)), 3, hashlib.sha256(b"abc").hexdigest(), 3, lambda: True),
        (_Response((b"ab",)), 3, hashlib.sha256(b"ab").hexdigest(), 3, lambda: False),
        (_Response((b"abc",)), 3, "0" * 64, 3, lambda: False),
        (
            _Response((b"abc",)),
            3,
            hashlib.sha256(b"abc").hexdigest(),
            3,
            iter((False, True)).__next__,
        ),
    ],
)
def test_download_rejects_invalid_or_cancelled_content(  # noqa: PLR0913
    tmp_path: Path,
    response: _Response,
    expected_bytes: int,
    expected_checksum: str,
    max_bytes: int,
    cancelled: Callable[[], bool],
) -> None:
    destination = tmp_path / "prepared.track.mp4"

    with pytest.raises(TransferFailureError):
        _client(_Opener(response)).download(
            "https://r2.example/object",
            destination,
            expected_bytes=expected_bytes,
            expected_checksum=expected_checksum,
            max_bytes=max_bytes,
            timeout_seconds=1.0,
            cancelled=cancelled,
        )

    assert not destination.exists()
    assert not destination.with_suffix(".mp4.pending").exists()


def test_download_maps_transport_and_filesystem_errors_safely(tmp_path: Path) -> None:
    destination = tmp_path / "prepared.track.mp4"
    client = _client(_Opener(error=urllib.error.URLError("private detail")))

    with pytest.raises(TransferFailureError) as transport:
        client.download(
            "https://r2.example/object",
            destination,
            expected_bytes=1,
            expected_checksum=hashlib.sha256(b"x").hexdigest(),
            max_bytes=1,
            timeout_seconds=1.0,
            cancelled=lambda: False,
        )
    assert str(transport.value) == ""

    destination.with_suffix(".mp4.pending").write_bytes(b"already present")
    with pytest.raises(TransferFailureError):
        _client(_Opener(_Response((b"x",)))).download(
            "https://r2.example/object",
            destination,
            expected_bytes=1,
            expected_checksum=hashlib.sha256(b"x").hexdigest(),
            max_bytes=1,
            timeout_seconds=1.0,
            cancelled=lambda: False,
        )
    assert not destination.with_suffix(".mp4.pending").exists()


def test_upload_validates_then_uses_a_bodyless_success_response(tmp_path: Path) -> None:
    value = b"observations"
    source = tmp_path / "observations.json.gz"
    source.write_bytes(value)
    opener = _Opener(_Response(status=204))

    _client(opener).upload(
        "https://r2.example/output?signature=secret",
        source,
        expected_bytes=len(value),
        expected_checksum=hashlib.sha256(value).hexdigest(),
        max_bytes=len(value),
        timeout_seconds=9.0,
        cancelled=lambda: False,
    )

    request, timeout = opener.requests[0]
    assert request.full_url == "https://r2.example/output?signature=secret"
    assert request.get_method() == "PUT"
    assert request.data == value
    assert request.get_header("Content-type") == "application/octet-stream"
    assert timeout == 9.0


@pytest.mark.parametrize(
    ("expected_bytes", "expected_checksum", "max_bytes", "cancelled"),
    [
        (3, hashlib.sha256(b"abc").hexdigest(), 3, lambda: True),
        (4, hashlib.sha256(b"abc").hexdigest(), 3, lambda: False),
        (2, hashlib.sha256(b"abc").hexdigest(), 3, lambda: False),
        (3, "0" * 64, 3, lambda: False),
        (3, hashlib.sha256(b"abc").hexdigest(), 3, iter((False, True)).__next__),
    ],
)
def test_upload_rejects_invalid_or_cancelled_content(
    tmp_path: Path,
    expected_bytes: int,
    expected_checksum: str,
    max_bytes: int,
    cancelled: Callable[[], bool],
) -> None:
    source = tmp_path / "observations.json.gz"
    source.write_bytes(b"abc")

    with pytest.raises(TransferFailureError):
        _client(_Opener(_Response(status=204))).upload(
            "https://r2.example/output",
            source,
            expected_bytes=expected_bytes,
            expected_checksum=expected_checksum,
            max_bytes=max_bytes,
            timeout_seconds=1.0,
            cancelled=cancelled,
        )


@pytest.mark.parametrize(
    "opener",
    [
        _Opener(_Response(status=500)),
        _Opener(_Response((b"unexpected",), status=200)),
        _Opener(error=urllib.error.URLError("private detail")),
    ],
)
def test_upload_rejects_transport_protocol_failures(
    tmp_path: Path,
    opener: _Opener,
) -> None:
    source = tmp_path / "observations.json.gz"
    source.write_bytes(b"abc")

    with pytest.raises(TransferFailureError):
        _client(opener).upload(
            "https://r2.example/output",
            source,
            expected_bytes=3,
            expected_checksum=hashlib.sha256(b"abc").hexdigest(),
            max_bytes=3,
            timeout_seconds=1.0,
            cancelled=lambda: False,
        )


def test_upload_maps_source_read_errors_safely(tmp_path: Path) -> None:
    with pytest.raises(TransferFailureError):
        _client(_Opener(_Response(status=204))).upload(
            "https://r2.example/output",
            tmp_path / "missing.json.gz",
            expected_bytes=1,
            expected_checksum=hashlib.sha256(b"x").hexdigest(),
            max_bytes=1,
            timeout_seconds=1.0,
            cancelled=lambda: False,
        )


def test_write_all_handles_partial_writes_and_rejects_no_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    writes = iter((1, 2))
    monkeypatch.setattr(
        "chassis_notes_gpu_worker.transfers.os.write", lambda *_: next(writes)
    )
    _write_all(1, b"abc")

    monkeypatch.setattr("chassis_notes_gpu_worker.transfers.os.write", lambda *_: 0)
    with pytest.raises(TransferFailureError):
        _write_all(1, b"x")


@pytest.mark.parametrize(
    "url",
    [
        "http://r2.example/object",
        "https:///object",
        "https://user@r2.example/object",
        "https://user:secret@r2.example/object",
        "https://r2.example/object#fragment",
    ],
)
def test_https_url_rejects_ambient_or_non_https_authority(url: str) -> None:
    with pytest.raises(TransferFailureError):
        _https_url(url)

    assert _https_url("https://r2.example/object?signature=secret") == (
        "https://r2.example/object?signature=secret"
    )
