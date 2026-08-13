import os
import selectors
import signal
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import IO, cast


class ProcessTimeoutError(RuntimeError):
    """A media process exceeded its wall-clock budget."""


class ProcessOutputLimitError(RuntimeError):
    """A media process exceeded its combined output budget."""


@dataclass(frozen=True)
class StderrLineObserver:
    consume: Callable[[bytes], bool]
    max_line_bytes: int

    def __post_init__(self) -> None:
        if self.max_line_bytes <= 0:
            msg = "Observed process lines require a positive byte bound"
            raise ValueError(msg)


@dataclass(frozen=True)
class ProcessStreams:
    standard_input: IO[bytes] | None = None
    standard_output: IO[bytes] | None = None
    standard_output_max_bytes: int | None = None
    standard_error_observer: StderrLineObserver | None = None

    def __post_init__(self) -> None:
        if (self.standard_output is None) != (self.standard_output_max_bytes is None):
            msg = "A streamed process output requires a byte bound"
            raise ValueError(msg)
        if (
            self.standard_output_max_bytes is not None
            and self.standard_output_max_bytes <= 0
        ):
            msg = "Streamed process output bounds must be positive"
            raise ValueError(msg)


@dataclass(frozen=True)
class ProcessResult:
    return_code: int
    stdout: bytes
    stderr: bytes
    elapsed_ms: int


@dataclass
class _StreamTarget:
    stream: IO[bytes]
    max_bytes: int
    byte_count: int = 0

    def write(self, chunk: bytes) -> None:
        if self.byte_count + len(chunk) > self.max_bytes:
            raise ProcessOutputLimitError
        remaining = memoryview(chunk)
        while remaining:
            written = self.stream.write(remaining)
            if written is None or written <= 0:
                msg = "Unable to write streamed process output"
                raise OSError(msg)
            self.byte_count += written
            remaining = remaining[written:]


@dataclass
class _ProcessCapture:
    max_output_bytes: int
    stderr_line_observer: StderrLineObserver | None
    stdout_target: _StreamTarget | None = None
    stdout: bytearray = field(default_factory=bytearray)
    stderr: bytearray = field(default_factory=bytearray)
    pending_stderr: bytearray = field(default_factory=bytearray)
    output_bytes: int = 0

    def consume(self, destination: object, chunk: bytes) -> None:
        if isinstance(destination, _StreamTarget):
            destination.write(chunk)
            return
        if not isinstance(destination, bytearray):
            msg = "Unexpected process output target"
            raise TypeError(msg)
        if destination is self.stderr and self.stderr_line_observer is not None:
            self._account(chunk)
            self._consume_stderr(chunk, final=False)
            return
        self._append(destination, chunk)

    def finish(self, destination: object) -> None:
        if destination is self.stderr and self.stderr_line_observer is not None:
            self._consume_stderr(b"", final=True)

    def _consume_stderr(self, chunk: bytes, *, final: bool) -> None:
        self.pending_stderr.extend(chunk)
        while True:
            newline_index = self.pending_stderr.find(b"\n")
            if newline_index < 0:
                break
            line = bytes(self.pending_stderr[:newline_index])
            del self.pending_stderr[: newline_index + 1]
            self._consume_line(line, suffix=b"\n")
        observer = cast("StderrLineObserver", self.stderr_line_observer)
        if len(self.pending_stderr) > observer.max_line_bytes:
            raise ProcessOutputLimitError
        if final and self.pending_stderr:
            line = bytes(self.pending_stderr)
            self.pending_stderr.clear()
            self._consume_line(line, suffix=b"")

    def _consume_line(self, line: bytes, *, suffix: bytes) -> None:
        observer = cast("StderrLineObserver", self.stderr_line_observer)
        if len(line) > observer.max_line_bytes:
            raise ProcessOutputLimitError
        if not observer.consume(line):
            self._store(self.stderr, line + suffix)

    def _append(self, destination: bytearray, chunk: bytes) -> None:
        self._account(chunk)
        destination.extend(chunk)

    def _account(self, chunk: bytes) -> None:
        if self.output_bytes + len(chunk) > self.max_output_bytes:
            raise ProcessOutputLimitError
        self.output_bytes += len(chunk)

    def _store(self, destination: bytearray, chunk: bytes) -> None:
        destination.extend(chunk)


class _ProcessScope:
    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        self.process = process

    def __enter__(self) -> subprocess.Popen[bytes]:
        return self.process

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        _terminate_process_group(self.process)
        if self.process.stdout is not None:
            self.process.stdout.close()
        if self.process.stderr is not None:
            self.process.stderr.close()


def run_bounded_process(
    executable: Path,
    arguments: tuple[str, ...],
    *,
    timeout_seconds: float,
    max_output_bytes: int,
    streams: ProcessStreams | None = None,
) -> ProcessResult:
    if not executable.is_absolute():
        msg = "Media executables must use absolute paths"
        raise ValueError(msg)
    if timeout_seconds <= 0 or max_output_bytes <= 0:
        msg = "Process bounds must be positive"
        raise ValueError(msg)
    started_at = time.monotonic()
    deadline = started_at + timeout_seconds
    resolved_streams = streams or ProcessStreams()
    process = subprocess.Popen(  # noqa: S603 - executable and arguments are internal
        (str(executable), *arguments),
        stdin=(
            subprocess.DEVNULL
            if resolved_streams.standard_input is None
            else resolved_streams.standard_input
        ),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
        close_fds=True,
        start_new_session=True,
    )

    capture = _ProcessCapture(
        max_output_bytes=max_output_bytes,
        stderr_line_observer=resolved_streams.standard_error_observer,
        stdout_target=(
            None
            if resolved_streams.standard_output is None
            else _StreamTarget(
                resolved_streams.standard_output,
                cast("int", resolved_streams.standard_output_max_bytes),
            )
        ),
    )
    with _ProcessScope(process):
        _read_process_output(
            process,
            capture,
            deadline=deadline,
        )
        remaining_seconds = max(0.0, deadline - time.monotonic())
        try:
            return_code = process.wait(timeout=remaining_seconds)
        except subprocess.TimeoutExpired as error:
            _terminate_process_group(process)
            raise ProcessTimeoutError from error

    elapsed_ms = max(0, round((time.monotonic() - started_at) * 1000))
    return ProcessResult(
        return_code=return_code,
        stdout=bytes(capture.stdout),
        stderr=bytes(capture.stderr),
        elapsed_ms=elapsed_ms,
    )


def _read_process_output(
    process: subprocess.Popen[bytes],
    capture: _ProcessCapture,
    *,
    deadline: float,
) -> None:
    if process.stderr is None:
        msg = "Media process pipes were not created"
        raise RuntimeError(msg)

    with selectors.DefaultSelector() as selector:
        if process.stdout is not None:
            selector.register(
                process.stdout,
                selectors.EVENT_READ,
                capture.stdout_target or capture.stdout,
            )
        selector.register(process.stderr, selectors.EVENT_READ, capture.stderr)

        while selector.get_map():
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                _terminate_process_group(process)
                raise ProcessTimeoutError

            events = selector.select(remaining_seconds)
            if not events:
                _terminate_process_group(process)
                raise ProcessTimeoutError

            for key, _ in events:
                stream = key.fileobj
                destination = key.data
                chunk = os.read(key.fd, 64 * 1024)
                if not chunk:
                    selector.unregister(stream)
                    capture.finish(destination)
                    continue
                capture.consume(destination, chunk)


def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    if process.poll() is None:
        process.wait()
