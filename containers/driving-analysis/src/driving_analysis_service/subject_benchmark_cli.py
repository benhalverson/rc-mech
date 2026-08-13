"""Command-line entry point for the hermetic synthetic benchmark."""

# Error text is intentionally short and local; the CLI never exposes details.
# ruff: noqa: EM101, TRY003

import argparse
import json
import sys
from pathlib import Path
from typing import TypeVar

from pydantic import TypeAdapter, ValidationError

from driving_analysis_service.benchmark import evaluate_benchmark
from driving_analysis_service.contracts import (
    AcceptedSubjectObservations,
    CorpusManifest,
    GroundTruth,
)

T = TypeVar("T")


def _read(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


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
        args.output.write_text(
            json.dumps(
                report.model_dump(by_alias=True, mode="json"),
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
    except (
        OSError,
        TypeError,
        json.JSONDecodeError,
        ValidationError,
        ValueError,
    ) as error:
        sys.stderr.write(f"invalid benchmark input: {type(error).__name__}\n")
        return 2
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
