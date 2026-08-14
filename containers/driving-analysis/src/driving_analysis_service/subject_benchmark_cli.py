"""Command-line entry point for hermetic stored-observation benchmarks."""

# Error text is intentionally short and local; the CLI never exposes details.
# ruff: noqa: EM101, TRY003

import argparse
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from driving_analysis_service.benchmark import (
    evaluate_benchmark,
    evaluate_representative_benchmark,
)
from driving_analysis_service.contracts import (
    AcceptedSubjectObservations,
    BenchmarkObservationSetV2,
    BenchmarkReport,
    CorpusManifest,
    GroundTruth,
    RepresentativeBenchmarkReportV2,
    RepresentativeCorpusManifestV2,
    RepresentativeGroundTruthV2,
)

MAX_BENCHMARK_INPUT_BYTES = 16 * 1024 * 1024


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("benchmark JSON contains duplicate object keys")
        result[key] = value
    return result


def _read(path: Path) -> object:
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
    )
    try:
        facts = os.fstat(descriptor)
        if not stat.S_ISREG(facts.st_mode):
            raise ValueError("benchmark input must be a regular file")
        if facts.st_size > MAX_BENCHMARK_INPUT_BYTES:
            raise ValueError("benchmark input exceeds size limit")
        with os.fdopen(descriptor, "rb") as input_file:
            descriptor = -1
            content = input_file.read(MAX_BENCHMARK_INPUT_BYTES + 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if len(content) > MAX_BENCHMARK_INPUT_BYTES:
        raise ValueError("benchmark input exceeds size limit")
    return json.loads(content.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)


def _reject_output_aliases(output: Path, inputs: tuple[Path, ...]) -> None:
    try:
        output_facts = output.stat()
    except FileNotFoundError:
        return
    for input_path in inputs:
        if os.path.samestat(output_facts, input_path.stat(follow_symlinks=False)):
            raise ValueError("benchmark output aliases an input")


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


def _is_representative(value: object) -> bool:
    return (
        isinstance(value, dict)
        and value.get("contractVersion") == "subject-benchmark.v2"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="subject-benchmark")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--ground-truth", required=True, type=Path)
    parser.add_argument("--observations", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        manifest_value = _read(args.manifest)
        truth_value = _read(args.ground_truth)
        observations_value = _read(args.observations)
        representative = _is_representative(manifest_value)
        report: BenchmarkReport | RepresentativeBenchmarkReportV2
        _reject_output_aliases(
            args.output, (args.manifest, args.ground_truth, args.observations)
        )
        if representative:
            representative_manifest = RepresentativeCorpusManifestV2.model_validate(
                manifest_value
            )
            representative_truth = RepresentativeGroundTruthV2.model_validate(
                truth_value
            )
            observation_set = BenchmarkObservationSetV2.model_validate(
                observations_value
            )
            report = evaluate_representative_benchmark(
                representative_manifest,
                representative_truth,
                observation_set,
            )
        else:
            manifest = CorpusManifest.model_validate(manifest_value)
            truth = GroundTruth.model_validate(truth_value)
            observations = _observations(observations_value)
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
