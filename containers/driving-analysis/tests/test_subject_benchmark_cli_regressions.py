import os
from pathlib import Path

import pytest

from driving_analysis_service.subject_benchmark_cli import main

FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "subject-benchmark"


def _copy_inputs(root: Path) -> list[Path]:
    paths = [
        root / "manifest.json",
        root / "ground-truth.json",
        root / "observations.json",
    ]
    source_names = ("manifest.json", "ground-truth.json", "accepted-observations.json")
    for path, source_name in zip(paths, source_names, strict=True):
        path.write_bytes((FIXTURE_ROOT / source_name).read_bytes())
    return paths


def _cli_args(paths: list[Path], output: Path) -> list[str]:
    return [
        "--manifest",
        str(paths[0]),
        "--ground-truth",
        str(paths[1]),
        "--observations",
        str(paths[2]),
        "--output",
        str(output),
    ]


@pytest.mark.parametrize("input_index", range(3))
def test_cli_rejects_output_path_equal_to_input(
    tmp_path: Path, input_index: int, capsys: pytest.CaptureFixture[str]
) -> None:
    paths = _copy_inputs(tmp_path)
    original = paths[input_index].read_bytes()

    assert main(_cli_args(paths, paths[input_index])) == 2

    assert paths[input_index].read_bytes() == original
    assert capsys.readouterr().err == "invalid benchmark input: ValueError\n"


@pytest.mark.parametrize("input_index", range(3))
def test_cli_rejects_hard_link_output_alias_to_input(
    tmp_path: Path, input_index: int, capsys: pytest.CaptureFixture[str]
) -> None:
    paths = _copy_inputs(tmp_path)
    output = tmp_path / "output.json"
    os.link(paths[input_index], output)
    original = paths[input_index].read_bytes()

    assert main(_cli_args(paths, output)) == 2

    assert paths[input_index].read_bytes() == original
    assert output.read_bytes() == original
    assert capsys.readouterr().err == "invalid benchmark input: ValueError\n"


@pytest.mark.parametrize("duplicate_location", [("root",), ("nested",)])
def test_cli_rejects_duplicate_json_keys_at_any_object_depth(
    tmp_path: Path,
    duplicate_location: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    paths = _copy_inputs(tmp_path)
    manifest = paths[0]
    manifest_text = manifest.read_text(encoding="utf-8")
    if duplicate_location == "root":
        duplicate = '  "contractVersion": "subject-benchmark.v1",\n'
        manifest_text = manifest_text.replace(duplicate, duplicate + duplicate, 1)
    else:
        duplicate = '      "recordingId": "synthetic-recording",\n'
        manifest_text = manifest_text.replace(
            duplicate,
            duplicate + '      "recordingId": "other-recording",\n',
            1,
        )
    manifest.write_text(manifest_text, encoding="utf-8")
    output = tmp_path / "output.json"

    assert main(_cli_args(paths, output)) == 2

    assert not output.exists()
    assert capsys.readouterr().err == "invalid benchmark input: ValueError\n"
