import os
import selectors
import subprocess
import sys
import threading
import time
from contextlib import AbstractContextManager
from pathlib import Path
from types import TracebackType
from typing import TYPE_CHECKING, Self, cast

import pytest

if TYPE_CHECKING:
    from collections.abc import Callable

import driving_analysis_service.processes as process_module
from driving_analysis_service.processes import (
    ProcessOutputLimitError,
    ProcessStreams,
    ProcessTimeoutError,
    StderrLineObserver,
    run_bounded_process,
)

PYTHON = Path(sys.executable).resolve()


def test_bounded_process_captures_stdout_stderr_and_return_code() -> None:
    result = run_bounded_process(
        PYTHON,
        ("-c", "import sys; print('out'); print('err', file=sys.stderr); sys.exit(3)"),
        timeout_seconds=5,
        max_output_bytes=1024,
    )

    assert result.return_code == 3
    assert result.stdout == b"out\n"
    assert result.stderr == b"err\n"
    assert result.elapsed_ms >= 0


def test_bounded_process_streams_stdout_without_retaining_it(tmp_path: Path) -> None:
    destination = tmp_path / "stdout.bin"
    with destination.open("xb") as output:
        result = run_bounded_process(
            PYTHON,
            ("-c", "import sys; sys.stdout.buffer.write(b'output')"),
            timeout_seconds=5,
            max_output_bytes=1024,
            streams=ProcessStreams(
                standard_output=output,
                standard_output_max_bytes=1024,
            ),
        )

    assert result.stdout == b""
    assert destination.read_bytes() == b"output"


def test_bounded_process_hard_limits_streamed_stdout(tmp_path: Path) -> None:
    destination = tmp_path / "stdout.bin"
    with (
        destination.open("xb", buffering=0) as output,
        pytest.raises(ProcessOutputLimitError),
    ):
        run_bounded_process(
            PYTHON,
            ("-c", "import sys; sys.stdout.buffer.write(b'x' * 100)"),
            timeout_seconds=5,
            max_output_bytes=1024,
            streams=ProcessStreams(
                standard_output=output,
                standard_output_max_bytes=32,
            ),
        )
    assert destination.stat().st_size <= 32


def test_bounded_process_allows_streamed_stdout_at_the_exact_limit(
    tmp_path: Path,
) -> None:
    destination = tmp_path / "stdout.bin"
    with destination.open("xb", buffering=0) as output:
        result = run_bounded_process(
            PYTHON,
            ("-c", "import sys; sys.stdout.buffer.write(b'x' * 32)"),
            timeout_seconds=5,
            max_output_bytes=1024,
            streams=ProcessStreams(
                standard_output=output,
                standard_output_max_bytes=32,
            ),
        )

    assert result.return_code == 0
    assert destination.read_bytes() == b"x" * 32


def test_streamed_process_output_requires_a_matching_positive_bound() -> None:
    with pytest.raises(ValueError, match="requires a byte bound"):
        ProcessStreams(standard_output=sys.stdout.buffer)
    with pytest.raises(ValueError, match="requires a byte bound"):
        ProcessStreams(standard_output_max_bytes=1)
    with pytest.raises(ValueError, match="bounds must be positive"):
        ProcessStreams(
            standard_output=sys.stdout.buffer,
            standard_output_max_bytes=0,
        )


def test_streamed_process_output_requires_a_regular_file() -> None:
    read_descriptor, write_descriptor = os.pipe()
    try:
        with (
            os.fdopen(write_descriptor, "wb", closefd=False) as output,
            pytest.raises(ValueError, match="regular file"),
        ):
            run_bounded_process(
                PYTHON,
                ("-c", "pass"),
                timeout_seconds=1,
                max_output_bytes=1,
                streams=ProcessStreams(
                    standard_output=output,
                    standard_output_max_bytes=1,
                ),
            )
    finally:
        os.close(read_descriptor)
        os.close(write_descriptor)


def test_bounded_process_consumes_selected_bounded_stderr_lines() -> None:
    observed: list[bytes] = []

    def observe(line: bytes) -> bool:
        observed.append(line)
        return line == b"drop"

    result = run_bounded_process(
        PYTHON,
        (
            "-c",
            "import sys; sys.stderr.write('drop\\nkeep')",
        ),
        timeout_seconds=5,
        max_output_bytes=1024,
        streams=ProcessStreams(standard_error_observer=StderrLineObserver(observe, 32)),
    )

    assert observed == [b"drop", b"keep"]
    assert result.stderr == b"keep"


def test_discarded_stderr_still_counts_toward_combined_output_limit() -> None:
    with pytest.raises(ProcessOutputLimitError):
        run_bounded_process(
            PYTHON,
            ("-c", "import sys; sys.stderr.write('x\\n' * 100)"),
            timeout_seconds=5,
            max_output_bytes=32,
            streams=ProcessStreams(
                standard_error_observer=StderrLineObserver(lambda _line: True, 16)
            ),
        )


def test_stderr_line_observer_requires_a_positive_bound() -> None:
    with pytest.raises(ValueError, match="positive byte bound"):
        StderrLineObserver(lambda _line: True, 0)


@pytest.mark.parametrize(
    ("executable", "timeout", "output_limit", "message"),
    [
        (Path("python"), 1, 1, "absolute paths"),
        (PYTHON, 0, 1, "bounds must be positive"),
        (PYTHON, 1, 0, "bounds must be positive"),
    ],
)
def test_bounded_process_requires_fixed_paths_and_positive_bounds(
    executable: Path,
    timeout: float,
    output_limit: int,
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        run_bounded_process(
            executable,
            (),
            timeout_seconds=timeout,
            max_output_bytes=output_limit,
        )


def test_bounded_process_enforces_timeout() -> None:
    with pytest.raises(ProcessTimeoutError):
        run_bounded_process(
            PYTHON,
            ("-c", "import time; time.sleep(2)"),
            timeout_seconds=0.01,
            max_output_bytes=1024,
        )


def test_bounded_process_enforces_timeout_after_output_pipes_close() -> None:
    started_at = time.monotonic()

    with pytest.raises(ProcessTimeoutError):
        run_bounded_process(
            PYTHON,
            (
                "-c",
                "import os,time; os.close(1); os.close(2); time.sleep(0.5)",
            ),
            timeout_seconds=0.02,
            max_output_bytes=1024,
        )

    assert time.monotonic() - started_at < 0.4


def test_bounded_process_timeout_terminates_process_group_descendants(
    tmp_path: Path,
) -> None:
    marker = tmp_path / "survived.txt"
    script = (
        "import os,time; from pathlib import Path; "
        "pid=os.fork(); pid and os._exit(0); "
        f"time.sleep(0.2); Path({str(marker)!r}).write_text('survived')"
    )

    with pytest.raises(ProcessTimeoutError):
        run_bounded_process(
            PYTHON,
            ("-c", script),
            timeout_seconds=0.05,
            max_output_bytes=1024,
        )

    time.sleep(0.3)
    assert not marker.exists()


def test_bounded_process_output_limit_terminates_process_group_descendants(
    tmp_path: Path,
) -> None:
    marker = tmp_path / "survived.txt"
    script = (
        "import os,time; from pathlib import Path; "
        "pid=os.fork(); pid and os._exit(0); "
        "time.sleep(0.05); os.write(2,b'x'*100); time.sleep(0.15); "
        f"Path({str(marker)!r}).write_text('survived')"
    )

    with pytest.raises(ProcessOutputLimitError):
        run_bounded_process(
            PYTHON,
            ("-c", script),
            timeout_seconds=1,
            max_output_bytes=32,
        )

    time.sleep(0.3)
    assert not marker.exists()


def test_bounded_process_enforces_combined_output_limit() -> None:
    with pytest.raises(ProcessOutputLimitError):
        run_bounded_process(
            PYTHON,
            ("-c", "import sys; sys.stdout.write('x' * 100); sys.stderr.write('y')"),
            timeout_seconds=5,
            max_output_bytes=32,
        )


@pytest.mark.parametrize("suffix", ["", "\n"])
def test_bounded_process_enforces_observed_line_limit(suffix: str) -> None:
    with pytest.raises(ProcessOutputLimitError):
        run_bounded_process(
            PYTHON,
            (
                "-c",
                f"import sys; sys.stderr.write('x' * 33 + {suffix!r})",
            ),
            timeout_seconds=5,
            max_output_bytes=1024,
            streams=ProcessStreams(
                standard_error_observer=StderrLineObserver(
                    lambda _line: True,
                    32,
                )
            ),
        )


def test_read_process_output_requires_both_pipes() -> None:
    process = subprocess.Popen(  # noqa: S603
        (str(PYTHON), "-c", "pass"),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    process.wait()

    with pytest.raises(RuntimeError):
        process_module._read_process_output(
            process,
            process_module._ProcessCapture(1, None),
            deadline=time.monotonic() + 1,
        )


def test_read_process_output_allows_stdout_to_be_absent() -> None:
    process = subprocess.Popen(  # noqa: S603
        (str(PYTHON), "-c", "import sys; sys.stderr.write('ready')"),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    capture = process_module._ProcessCapture(1024, None)
    process_module._read_process_output(
        process,
        capture,
        deadline=time.monotonic() + 1,
    )
    process.wait()
    assert capture.stderr == b"ready"


def test_read_process_output_rejects_an_expired_deadline() -> None:
    process = subprocess.Popen(  # noqa: S603
        (str(PYTHON), "-c", "import time; time.sleep(2)"),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )

    with pytest.raises(ProcessTimeoutError):
        process_module._read_process_output(
            process,
            process_module._ProcessCapture(1, None),
            deadline=time.monotonic() - 1,
        )


def test_terminate_process_group_tolerates_finished_and_missing_processes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    finished = subprocess.Popen(  # noqa: S603
        (str(PYTHON), "-c", "pass"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    finished.wait()
    process_module._terminate_process_group(finished)

    running = subprocess.Popen(  # noqa: S603
        (str(PYTHON), "-c", "import time; time.sleep(2)"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )

    def missing_group(_pid: int, _signal: int) -> None:
        raise ProcessLookupError

    monkeypatch.setattr(os, "killpg", missing_group)
    process_module._terminate_process_group(running)
    running.kill()
    running.wait()


class _NonReapingProcess:
    pid = 123

    def poll(self) -> None:
        return None

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        msg = "foreground wait must not run"
        raise AssertionError(msg)


def test_terminate_process_group_schedules_reaping_without_waiting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = cast("subprocess.Popen[bytes]", _NonReapingProcess())
    scheduled: list[subprocess.Popen[bytes]] = []
    monkeypatch.setattr(os, "killpg", lambda _pid, _signal: None)
    monkeypatch.setattr(process_module, "_schedule_process_reap", scheduled.append)

    process_module._terminate_process_group(process)

    assert scheduled == [process]


def test_background_process_reaper_releases_its_single_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = cast("subprocess.Popen[bytes]", _NonReapingProcess())
    released = threading.Event()

    class _Slot:
        def acquire(self, *, blocking: bool) -> bool:
            assert blocking is False
            return True

        def release(self) -> None:
            released.set()

    class _Worker:
        def __init__(
            self,
            *,
            target: object,
            daemon: bool,
            name: str,
        ) -> None:
            assert daemon is True
            assert name == "bounded-process-reaper"
            self.target = cast("Callable[[], None]", target)

        def start(self) -> None:
            with pytest.raises(AssertionError, match="foreground wait"):
                self.target()

    monkeypatch.setattr(process_module, "_PROCESS_REAP_SLOTS", _Slot())
    monkeypatch.setattr(process_module, "Thread", _Worker)

    process_module._schedule_process_reap(process)

    assert released.is_set()


def test_background_process_reaper_releases_slot_when_start_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = cast("subprocess.Popen[bytes]", _NonReapingProcess())
    released = threading.Event()

    class _Slot:
        def acquire(self, *, blocking: bool) -> bool:
            assert blocking is False
            return True

        def release(self) -> None:
            released.set()

    class _Worker:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def start(self) -> None:
            msg = "thread unavailable"
            raise RuntimeError(msg)

    monkeypatch.setattr(process_module, "_PROCESS_REAP_SLOTS", _Slot())
    monkeypatch.setattr(process_module, "Thread", _Worker)

    with pytest.raises(RuntimeError, match="thread unavailable"):
        process_module._schedule_process_reap(process)

    assert released.is_set()


class _ProcessWithoutPipes:
    stdout = None
    stderr = None

    def poll(self) -> None:
        return None


def test_process_scope_terminates_a_live_process_without_optional_pipes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = cast("subprocess.Popen[bytes]", _ProcessWithoutPipes())
    terminated: list[subprocess.Popen[bytes]] = []
    monkeypatch.setattr(
        process_module,
        "_terminate_process_group",
        terminated.append,
    )

    with process_module._ProcessScope(process):
        pass

    assert terminated == [process]


class _BadDataSelector(AbstractContextManager["_BadDataSelector"]):
    def __init__(self) -> None:
        self.file_object: object | None = None

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        return None

    def register(self, file_object: object, _events: int, _data: object) -> None:
        if self.file_object is None:
            self.file_object = file_object

    def get_map(self) -> dict[int, object]:
        return {1: object()}

    def select(self, _timeout: float) -> list[tuple[selectors.SelectorKey, int]]:
        assert self.file_object is not None
        file_descriptor = cast("int", self.file_object.fileno())  # type: ignore[attr-defined]
        key = selectors.SelectorKey(
            fileobj=file_descriptor,
            fd=file_descriptor,
            events=selectors.EVENT_READ,
            data="not-a-bytearray",
        )
        return [(key, selectors.EVENT_READ)]


def test_read_process_output_rejects_an_unexpected_output_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = subprocess.Popen(  # noqa: S603
        (str(PYTHON), "-c", "print('ready')"),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    process.wait()
    monkeypatch.setattr(selectors, "DefaultSelector", _BadDataSelector)

    with pytest.raises(TypeError, match="Unexpected process output target"):
        process_module._read_process_output(
            process,
            process_module._ProcessCapture(1024, None),
            deadline=time.monotonic() + 1,
        )

    assert process.stdout is not None
    assert process.stderr is not None
    process.stdout.close()
    process.stderr.close()
