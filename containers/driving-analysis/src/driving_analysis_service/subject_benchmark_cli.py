"""Command-line entry point for the hermetic synthetic benchmark."""

# Error text is intentionally short and local; the CLI never exposes details.
# ruff: noqa: EM101, TRY003

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from driving_analysis_service.benchmark import evaluate_benchmark
from driving_analysis_service.contracts import (
    AcceptedSubjectObservations,
    CorpusManifest,
    GroundTruth,
)

MAX_BENCHMARK_INPUT_BYTES = 16 * 1024 * 1024


def _read(path: Path) -> object:
    if path.stat().st_size > MAX_BENCHMARK_INPUT_BYTES:
        raise ValueError("benchmark input exceeds size limit")
    return json.loads(path.read_bytes().decode("utf-8"))


def _write(path: Path, report: str) -> None:
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(report)
            temporary.flush()
            os.fsync(temporary.fileno())
        temporary_path.chmod(0o600)
        temporary_path.replace(path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _observations(value: object) -> dict[str, AcceptedSubjectObservations]:
    if not isinstance(value, list):
        raise TypeError("observations must be a JSON array")
    adapter = TypeAdapter(AcceptedSubjectObservations)
    parsed = [adapter.validate_python(item) for item in value]
    result = {item.case_id: item for item in parsed}
    if len(result) != len(parsed):
        raise ValueError("observations contain duplicate case IDs")
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="subject-benchmark")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--ground-truth", required=True, type=Path)
    parser.add_argument("--observations", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        manifest = CorpusManifest.model_validate(_read(args.manifest))
        truth = GroundTruth.model_validate(_read(args.ground_truth))
        observations = _observations(_read(args.observations))
        report = evaluate_benchmark(manifest, truth, observations)
        _write(
            args.output,
            json.dumps(
                report.model_dump(by_alias=True, mode="json"),
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
        )
    except (
        OSError,
        RecursionError,
        TypeError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValidationError,
        ValueError,
    ) as error:
        sys.stderr.write(f"invalid benchmark input: {type(error).__name__}\n")
        return 2
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
