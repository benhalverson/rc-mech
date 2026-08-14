import hashlib
import os
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import override
from urllib.parse import urlsplit

TRANSFER_CHUNK_BYTES = 1024 * 1024
HTTP_SUCCESS_MIN = 200
HTTP_SUCCESS_MAX = 300


class TransferFailureError(RuntimeError):
    """A capability-scoped transfer failed without exposing its URL."""


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    @override
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> urllib.request.Request | None:
        del req, fp, code, msg, headers, newurl
        return None


class TransferClient:
    def __init__(self) -> None:
        self._opener = urllib.request.build_opener(_RejectRedirects)

    def download(  # noqa: PLR0913 - each bound is an explicit capability check
        self,
        url: str,
        destination: Path,
        *,
        expected_bytes: int,
        expected_checksum: str,
        max_bytes: int,
        timeout_seconds: float,
        cancelled: Callable[[], bool],
    ) -> None:
        limit = min(expected_bytes, max_bytes)
        request = urllib.request.Request(_https_url(url), method="GET")  # noqa: S310
        pending = destination.with_suffix(f"{destination.suffix}.pending")
        digest = hashlib.sha256()
        byte_count = 0
        try:
            with self._opener.open(request, timeout=timeout_seconds) as response:
                content_length = response.headers.get("Content-Length")
                if content_length is not None and int(content_length) != expected_bytes:
                    raise TransferFailureError
                descriptor = os.open(
                    pending,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                try:
                    while chunk := response.read(TRANSFER_CHUNK_BYTES):
                        if cancelled() or byte_count + len(chunk) > limit:
                            raise TransferFailureError
                        _write_all(descriptor, chunk)
                        digest.update(chunk)
                        byte_count += len(chunk)
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            if (
                byte_count != expected_bytes
                or digest.hexdigest() != expected_checksum
                or cancelled()
            ):
                raise TransferFailureError
            pending.replace(destination)
        except (
            OSError,
            TimeoutError,
            ValueError,
            urllib.error.HTTPError,
            urllib.error.URLError,
        ):
            raise TransferFailureError from None
        finally:
            pending.unlink(missing_ok=True)

    def upload(  # noqa: PLR0913 - each bound is an explicit capability check
        self,
        url: str,
        source: Path,
        *,
        expected_bytes: int,
        expected_checksum: str,
        max_bytes: int,
        timeout_seconds: float,
        cancelled: Callable[[], bool],
    ) -> None:
        try:
            if cancelled() or expected_bytes > max_bytes:
                raise TransferFailureError
            payload = source.read_bytes()
            if (
                cancelled()
                or len(payload) != expected_bytes
                or hashlib.sha256(payload).hexdigest() != expected_checksum
            ):
                raise TransferFailureError
            request = urllib.request.Request(  # noqa: S310
                _https_url(url),
                data=payload,
                headers={"Content-Type": "application/octet-stream"},
                method="PUT",
            )
            with self._opener.open(request, timeout=timeout_seconds) as response:
                if not HTTP_SUCCESS_MIN <= response.status < HTTP_SUCCESS_MAX:
                    raise TransferFailureError
                if response.read(1):
                    raise TransferFailureError
        except (OSError, TimeoutError, urllib.error.HTTPError, urllib.error.URLError):
            raise TransferFailureError from None


def _write_all(descriptor: int, value: bytes) -> None:
    offset = 0
    while offset < len(value):
        written = os.write(descriptor, value[offset:])
        if written <= 0:
            raise TransferFailureError
        offset += written


def _https_url(url: str) -> str:
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise TransferFailureError
    return url
