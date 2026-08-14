import runpy
import subprocess
import sys
from pathlib import Path

import pytest

from chassis_notes_gpu_worker import quality


def test_quality_runs_formatter_linter_and_tests(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[tuple[str, ...], Path, bool]] = []

    def run(command: tuple[str, ...], *, cwd: Path, check: bool) -> None:
        calls.append((command, cwd, check))

    monkeypatch.setattr(subprocess, "run", run)

    quality.main()

    project_root = Path(quality.__file__).resolve().parents[2]
    assert calls == [
        ((sys.executable, "-m", "ruff", "format", "--check", "."), project_root, True),
        ((sys.executable, "-m", "ruff", "check", "."), project_root, True),
        ((sys.executable, "-m", "pytest"), project_root, True),
    ]


def test_quality_module_entrypoint(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda command, **_options: calls.append(command),
    )

    runpy.run_path(quality.__file__, run_name="__main__")

    assert len(calls) == 3
