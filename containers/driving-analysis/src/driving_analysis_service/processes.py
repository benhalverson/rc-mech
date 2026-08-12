import os
import selectors
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType


class ProcessTimeoutError(RuntimeError):
    """A media process exceeded its wall-clock budget."""


class ProcessOutputLimitError(RuntimeError):
    """A media process exceeded its combined output budget."""


@dataclass(frozen=True)
class ProcessResult:
    return_code: int
    stdout: bytes
    stderr: bytes
    elapsed_ms: int


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
        if self.process.poll() is None:
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
) -> ProcessResult:
    if not executable.is_absolute():
        msg = "Media executables must use absolute paths"
        raise ValueError(msg)
    if timeout_seconds <= 0 or max_output_bytes <= 0:
        msg = "Process bounds must be positive"
        raise ValueError(msg)

    started_at = time.monotonic()
    process = subprocess.Popen(  # noqa: S603 - executable and arguments are internal
        (str(executable), *arguments),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
        close_fds=True,
        start_new_session=True,
    )

    stdout = bytearray()
    stderr = bytearray()
    with _ProcessScope(process):
        _read_process_output(
            process,
            stdout,
            stderr,
            deadline=started_at + timeout_seconds,
            max_output_bytes=max_output_bytes,
        )
        return_code = process.wait()

    elapsed_ms = max(0, round((time.monotonic() - started_at) * 1000))
    return ProcessResult(
        return_code=return_code,
        stdout=bytes(stdout),
        stderr=bytes(stderr),
        elapsed_ms=elapsed_ms,
    )


def _read_process_output(
    process: subprocess.Popen[bytes],
    stdout: bytearray,
    stderr: bytearray,
    *,
    deadline: float,
    max_output_bytes: int,
) -> None:
    if process.stdout is None or process.stderr is None:
        msg = "Media process pipes were not created"
        raise RuntimeError(msg)

    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ, stdout)
        selector.register(process.stderr, selectors.EVENT_READ, stderr)

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
                chunk = os.read(key.fd, 64 * 1024)
                if not chunk:
                    selector.unregister(stream)
                    continue

                destination = key.data
                if not isinstance(destination, bytearray):
                    msg = "Unexpected process output target"
                    raise TypeError(msg)
                destination.extend(chunk)
                if len(stdout) + len(stderr) > max_output_bytes:
                    _terminate_process_group(process)
                    raise ProcessOutputLimitError


def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    process.wait()
