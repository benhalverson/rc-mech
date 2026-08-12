import io
import os
import tempfile
from collections.abc import Callable
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from typing import cast

import pytest

import driving_analysis_service.media as media_module
from driving_analysis_service.contracts import MediaValidationRequest
from driving_analysis_service.errors import MediaValidationError
from driving_analysis_service.media import MediaValidationService
from driving_analysis_service.processes import (
    ProcessOutputLimitError,
    ProcessResult,
    ProcessTimeoutError,
)
from driving_analysis_service.settings import ServiceSettings
from tests.conftest import STAGED_MEDIA_ID, request_body


def _valid_probe() -> dict[str, object]:
    return {
        "streams": [
            {
                "index": 0,
                "codec_type": "video",
                "codec_name": "h264",
                "width": 160,
                "height": 90,
                "sample_aspect_ratio": "1:1",
                "avg_frame_rate": "10/1",
                "r_frame_rate": "10/1",
                "time_base": "1/10240",
                "start_time": "0.000",
                "duration": "0.500",
            }
        ],
        "format": {
            "format_name": "mov,mp4",
            "start_time": "0.000",
            "duration": "0.500",
        },
    }


def _video(probe: dict[str, object]) -> dict[str, object]:
    streams = cast("list[object]", probe["streams"])
    return cast("dict[str, object]", streams[0])


def _error_code(
    callable_under_test: Callable[[], object],
    expected_code: str = "UNSUPPORTED_MEDIA",
) -> None:
    with pytest.raises(MediaValidationError) as raised:
        callable_under_test()
    assert raised.value.code == expected_code


def test_parse_probe_supports_safe_audio_and_metadata_fallbacks(
    settings: ServiceSettings,
) -> None:
    probe = _valid_probe()
    video = _video(probe)
    video["sample_aspect_ratio"] = "N/A"
    video["avg_frame_rate"] = "0/0"
    video["start_time"] = "-0.125"
    cast("list[object]", probe["streams"]).append(
        {"codec_type": "audio", "codec_name": "aac"}
    )

    parsed = media_module._parse_probe(probe, settings)

    assert parsed.audio_codecs == ("aac",)
    assert parsed.average_frame_rate.numerator == 10
    assert parsed.sample_aspect_ratio.numerator == 1
    assert parsed.start_time_ms == -125


@pytest.mark.parametrize(
    "invalid_root",
    [None, [], {"streams": "not-a-list", "format": {}}, {"streams": [], "format": {}}],
)
def test_parse_probe_rejects_invalid_roots(
    settings: ServiceSettings,
    invalid_root: object,
) -> None:
    _error_code(lambda: media_module._parse_probe(invalid_root, settings))


def test_parse_probe_rejects_multiple_video_streams(settings: ServiceSettings) -> None:
    probe = _valid_probe()
    cast("list[object]", probe["streams"]).append(deepcopy(_video(probe)))

    _error_code(lambda: media_module._parse_probe(probe, settings))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("index", -1),
        ("index", True),
        ("width", 0),
        ("width", True),
        ("height", "90"),
        ("codec_name", ""),
        ("codec_name", "x" * 33),
        ("codec_name", "h264;unsafe"),
        ("time_base", "0/1"),
        ("time_base", "1/0"),
        ("time_base", "not-rational"),
    ],
)
def test_parse_probe_rejects_invalid_video_metadata(
    settings: ServiceSettings,
    field: str,
    value: object,
) -> None:
    probe = _valid_probe()
    _video(probe)[field] = value

    _error_code(lambda: media_module._parse_probe(probe, settings))


def test_parse_probe_enforces_height_limit(settings: ServiceSettings) -> None:
    probe = _valid_probe()
    _video(probe)["height"] = 360

    _error_code(
        lambda: media_module._parse_probe(probe, settings),
        "MEDIA_OVER_LIMIT",
    )


@pytest.mark.parametrize(
    "rotation_metadata",
    [
        {"tags": {"rotate": "90"}},
        {"side_data_list": [{"rotation": -90}]},
    ],
)
def test_parse_probe_rejects_rotated_layout(
    settings: ServiceSettings,
    rotation_metadata: dict[str, object],
) -> None:
    probe = _valid_probe()
    _video(probe).update(rotation_metadata)

    _error_code(
        lambda: media_module._parse_probe(probe, settings),
        "INCOMPATIBLE_LAYOUT",
    )


def test_parse_probe_rejects_invalid_rotation(settings: ServiceSettings) -> None:
    probe = _valid_probe()
    _video(probe)["tags"] = {"rotate": "sideways"}

    _error_code(lambda: media_module._parse_probe(probe, settings))


def test_parse_probe_ignores_non_numeric_side_data_rotation(
    settings: ServiceSettings,
) -> None:
    probe = _valid_probe()
    _video(probe)["side_data_list"] = [{"rotation": True}, {"kind": "display"}]

    assert media_module._parse_probe(probe, settings).width == 160


def test_parse_probe_rejects_too_many_audio_streams(
    settings: ServiceSettings,
) -> None:
    probe = _valid_probe()
    streams = cast("list[object]", probe["streams"])
    streams.extend({"codec_type": "audio", "codec_name": "aac"} for _ in range(9))

    _error_code(lambda: media_module._parse_probe(probe, settings))


def test_parse_probe_rejects_too_many_container_formats(
    settings: ServiceSettings,
) -> None:
    probe = _valid_probe()
    raw_format = cast("dict[str, object]", probe["format"])
    raw_format["format_name"] = "a,b,c,d,e,f,g,h,i"

    _error_code(lambda: media_module._parse_probe(probe, settings))


@pytest.mark.parametrize(
    "duration",
    [None, "N/A", "invalid", "NaN", "-1", "0"],
)
def test_parse_probe_rejects_invalid_duration(
    settings: ServiceSettings,
    duration: object,
) -> None:
    probe = _valid_probe()
    _video(probe)["duration"] = duration
    cast("dict[str, object]", probe["format"])["duration"] = duration

    _error_code(lambda: media_module._parse_probe(probe, settings))


def test_parse_probe_falls_back_to_stream_duration(settings: ServiceSettings) -> None:
    probe = _valid_probe()
    cast("dict[str, object]", probe["format"])["duration"] = "N/A"

    assert media_module._parse_probe(probe, settings).duration_ms == 500


def test_parse_probe_rejects_all_invalid_frame_rates(
    settings: ServiceSettings,
) -> None:
    probe = _valid_probe()
    _video(probe)["avg_frame_rate"] = "0/0"
    _video(probe)["r_frame_rate"] = "0/0"

    _error_code(lambda: media_module._parse_probe(probe, settings))


def test_decode_progress_parsing_is_strict() -> None:
    assert media_module._decoded_frame_count(b"noise\nframe=2\nframe=5\n") == 5
    assert media_module._decoded_frame_count(b"frame=nope\nframe=\n") == 0
    _error_code(lambda: media_module._decoded_frame_count(b"\xff"), "CORRUPT_MEDIA")


def test_layout_observer_rejects_a_midstream_sample_aspect_ratio_change(
    settings: ServiceSettings,
) -> None:
    metadata = media_module._parse_probe(_valid_probe(), settings)
    observer = media_module._DecodedLayoutObserver(
        metadata,
        settings.limits.max_frames,
    )
    prefix = b"[Parsed_showinfo_0 @ 0x1] n:  "

    assert observer(prefix + b"0 fmt:yuv420p sar:1/1 s:160x90 i:P")
    with pytest.raises(MediaValidationError) as raised:
        observer(prefix + b"1 fmt:yuv420p sar:2/1 s:160x90 i:P")

    assert raised.value.code == "INCOMPATIBLE_LAYOUT"
    assert raised.value.stage == "decode"


def test_layout_observer_filters_showinfo_and_rejects_invalid_frames(
    settings: ServiceSettings,
) -> None:
    metadata = media_module._parse_probe(_valid_probe(), settings)
    observer = media_module._DecodedLayoutObserver(metadata, 1)
    prefix = b"[Parsed_showinfo_0 @ 0x1]"

    assert not observer(b"unrelated log line")
    assert observer(prefix + b" config in time_base: 1/1000")
    _error_code(lambda: observer(prefix + b" n: 0 malformed"), "CORRUPT_MEDIA")
    _error_code(
        lambda: observer(prefix + b" n: 0 sar:1/0 s:160x90"),
        "CORRUPT_MEDIA",
    )
    assert observer(prefix + b" n: 0 sar:1/1 s:160x90")
    _error_code(
        lambda: observer(prefix + b" n: 1 sar:1/1 s:160x90"),
        "MEDIA_OVER_LIMIT",
    )


@pytest.mark.parametrize("matrix_name", [b"displaymatrix", b"3x3 displaymatrix"])
def test_layout_observer_validates_display_rotation(
    settings: ServiceSettings,
    matrix_name: bytes,
) -> None:
    metadata = media_module._parse_probe(_valid_probe(), settings)
    observer = media_module._DecodedLayoutObserver(metadata, 1)
    prefix = b"[Parsed_showinfo_0 @ 0x1] side data - " + matrix_name + b": rotation of "

    assert observer(prefix + b"0.00 degrees")
    _error_code(lambda: observer(prefix + b"unknown degrees"), "CORRUPT_MEDIA")
    _error_code(lambda: observer(prefix + b"-90.00 degrees"), "INCOMPATIBLE_LAYOUT")


@pytest.mark.parametrize("dimensions", [(161, 90), (160, 91)])
def test_layout_observer_rejects_dimension_changes(
    settings: ServiceSettings,
    dimensions: tuple[int, int],
) -> None:
    metadata = media_module._parse_probe(_valid_probe(), settings)
    observer = media_module._DecodedLayoutObserver(metadata, 1)
    width, height = dimensions

    _error_code(
        lambda: observer(
            b"[Parsed_showinfo_0 @ 0x1] n: 0 sar:1/1 " + f"s:{width}x{height}".encode()
        ),
        "INCOMPATIBLE_LAYOUT",
    )


@pytest.mark.parametrize(
    ("result_or_error", "expected_code"),
    [
        (ProcessTimeoutError(), "PROCESS_TIMEOUT"),
        (ProcessOutputLimitError(), "MEDIA_OVER_LIMIT"),
        (ProcessResult(1, b"", b"private", 1), "CORRUPT_MEDIA"),
        (ProcessResult(0, b"frame=101\n", b"", 1), "MEDIA_OVER_LIMIT"),
        (ProcessResult(0, b"progress=end\n", b"", 1), "CORRUPT_MEDIA"),
        (ProcessResult(0, b"frame=1\nprogress=end\n", b"", 1), "CORRUPT_MEDIA"),
    ],
)
def test_decode_maps_bounded_process_outcomes(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    result_or_error: ProcessResult | Exception,
    expected_code: str,
) -> None:
    def fake_run(*_args: object, **_kwargs: object) -> ProcessResult:
        if isinstance(result_or_error, Exception):
            raise result_or_error
        return result_or_error

    monkeypatch.setattr(media_module, "run_bounded_process", fake_run)
    metadata = media_module._parse_probe(_valid_probe(), settings)
    _error_code(
        lambda: media_module._decode_media(
            tmp_path / "input.media",
            metadata,
            settings,
        ),
        expected_code,
    )


@pytest.mark.parametrize(
    ("result_or_error", "expected_code"),
    [
        (ProcessTimeoutError(), "PROCESS_TIMEOUT"),
        (ProcessOutputLimitError(), "MEDIA_OVER_LIMIT"),
        (ProcessResult(0, b"not-json", b"", 1), "CORRUPT_MEDIA"),
        (ProcessResult(0, b"\xff", b"", 1), "CORRUPT_MEDIA"),
    ],
)
def test_probe_maps_bounded_process_and_json_failures(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    result_or_error: ProcessResult | Exception,
    expected_code: str,
) -> None:
    def fake_run(*_args: object, **_kwargs: object) -> ProcessResult:
        if isinstance(result_or_error, Exception):
            raise result_or_error
        return result_or_error

    monkeypatch.setattr(media_module, "run_bounded_process", fake_run)
    _error_code(
        lambda: media_module._probe_media(tmp_path / "input.media", settings),
        expected_code,
    )


class _ChangingFile:
    def __init__(self, reported_size: int, contents: bytes) -> None:
        self.reported_size = reported_size
        self.contents = contents

    class _Stat:
        def __init__(self, size: int) -> None:
            self.st_size = size

    def stat(self) -> "_ChangingFile._Stat":
        return self._Stat(self.reported_size)

    def open(self, _mode: str) -> io.BytesIO:
        return io.BytesIO(self.contents)


@pytest.mark.parametrize(
    ("reported_size", "contents", "max_bytes", "expected_code"),
    [
        (1, b"xx", 1, "MEDIA_OVER_LIMIT"),
        (2, b"x", 2, "STAGED_MEDIA_MISMATCH"),
    ],
)
def test_inspection_detects_a_file_that_changes_during_hashing(
    reported_size: int,
    contents: bytes,
    max_bytes: int,
    expected_code: str,
) -> None:
    changing = _ChangingFile(reported_size, contents)
    _error_code(
        lambda: media_module._inspect_file(
            cast("Path", changing),
            expected_byte_count=reported_size,
            max_bytes=max_bytes,
        ),
        expected_code,
    )


def test_inspection_rejects_a_file_over_the_byte_limit(tmp_path: Path) -> None:
    media_path = tmp_path / "large.media"
    media_path.write_bytes(b"large")

    _error_code(
        lambda: media_module._inspect_file(
            media_path,
            expected_byte_count=5,
            max_bytes=1,
        ),
        "MEDIA_OVER_LIMIT",
    )


def test_service_redacts_unexpected_internal_errors(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = MediaValidationRequest.model_validate(request_body(1))

    def fail_roots(_settings: ServiceSettings) -> None:
        msg = "private path and provider text"
        raise RuntimeError(msg)

    monkeypatch.setattr(ServiceSettings, "prepare_roots", fail_roots)
    response = MediaValidationService(settings).validate(request)

    assert response.outcome == "rejected"
    assert response.error.code == "INTERNAL_ERROR"
    assert "private" not in response.error.message


def test_claim_maps_non_missing_os_errors_and_cleanup_is_idempotent(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings.prepare_roots()
    (settings.staging_root / f"{STAGED_MEDIA_ID}.media").write_bytes(b"x")
    request = MediaValidationRequest.model_validate(request_body(1))
    claim = media_module._claimed_media(request, settings)

    def deny_copy(*_args: object, **_kwargs: object) -> None:
        raise PermissionError

    monkeypatch.setattr(media_module, "_copy_and_consume", deny_copy)
    _error_code(claim.__enter__, "INTERNAL_ERROR")
    claim._cleanup()
    assert list(settings.work_root.iterdir()) == []


def test_claim_cleans_staging_when_work_directory_creation_fails(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings.prepare_roots()
    request = MediaValidationRequest.model_validate(request_body(1))
    real_mkdtemp = tempfile.mkdtemp

    def deny_work_directory(*, prefix: str, dir: Path) -> str:  # noqa: A002
        if prefix == "request-":
            raise PermissionError
        return real_mkdtemp(prefix=prefix, dir=dir)

    monkeypatch.setattr(tempfile, "mkdtemp", deny_work_directory)

    _error_code(
        media_module._claimed_media(request, settings).__enter__,
        "INTERNAL_ERROR",
    )
    assert list(settings.staging_root.iterdir()) == []
    assert list(settings.work_root.iterdir()) == []


def test_claim_creates_a_private_snapshot_before_validation(
    settings: ServiceSettings,
) -> None:
    settings.prepare_roots()
    source = settings.staging_root / f"{STAGED_MEDIA_ID}.media"
    source.write_bytes(b"media")
    retained_link = settings.staging_root / "retained-link.media"
    retained_link.hardlink_to(source)
    request = MediaValidationRequest.model_validate(request_body(5))
    claim = media_module._claimed_media(request, settings)

    with claim as claimed_path:
        assert claimed_path.read_bytes() == b"media"
        assert not source.exists()
        retained_link.write_bytes(b"other")
        assert claimed_path.read_bytes() == b"media"

    assert list(settings.work_root.iterdir()) == []


def test_cross_filesystem_copy_consumes_over_limit_source(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.media"
    destination = tmp_path / "destination.media"
    source.write_bytes(b"too large")

    _error_code(
        lambda: media_module._copy_and_consume(source, destination, max_bytes=1),
        "MEDIA_OVER_LIMIT",
    )
    assert not source.exists()


def test_cross_filesystem_copy_detects_source_identity_change(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.media"
    destination = tmp_path / "destination.media"
    source.write_bytes(b"media")
    real_lstat = Path.lstat

    def changed_identity(path: Path) -> os.stat_result:
        identity = real_lstat(path)
        values = list(identity)
        values[1] = identity.st_ino + 1
        return os.stat_result(values)

    monkeypatch.setattr(Path, "lstat", changed_identity)
    with pytest.raises(OSError, match="identity changed"):
        media_module._copy_and_consume(source, destination, max_bytes=100)


def test_open_staged_source_preserves_a_regular_file_when_open_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.media"
    source.write_bytes(b"media")

    def deny_open(*_args: object, **_kwargs: object) -> int:
        raise PermissionError

    monkeypatch.setattr(os, "open", deny_open)
    with pytest.raises(PermissionError):
        media_module._open_staged_source(source)

    assert source.read_bytes() == b"media"


def test_unlink_same_file_tolerates_an_already_consumed_source(tmp_path: Path) -> None:
    media_module._unlink_same_file(tmp_path / "missing", 1, 1)


def test_write_all_rejects_a_stalled_write(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(os, "write", lambda _descriptor, _data: 0)

    with pytest.raises(OSError, match="Unable to copy"):
        media_module._write_all(1, b"media")


def test_discard_tolerates_a_missing_staged_input(tmp_path: Path) -> None:
    media_module._discard_staged_input(tmp_path / "missing")


def test_claim_reports_cleanup_failure_for_nonempty_invalid_input(
    settings: ServiceSettings,
) -> None:
    settings.prepare_roots()
    invalid = settings.staging_root / f"{STAGED_MEDIA_ID}.media"
    invalid.mkdir()
    (invalid / "child").write_bytes(b"media")
    request = MediaValidationRequest.model_validate(request_body(1))

    _error_code(
        media_module._claimed_media(request, settings).__enter__,
        "INTERNAL_ERROR",
    )


def test_claim_cleans_workspace_when_cross_filesystem_copy_is_over_limit(
    settings: ServiceSettings,
) -> None:
    limited_settings = replace(settings, limits=replace(settings.limits, max_bytes=1))
    limited_settings.prepare_roots()
    source = limited_settings.staging_root / f"{STAGED_MEDIA_ID}.media"
    source.write_bytes(b"media")
    request = MediaValidationRequest.model_validate(request_body(5))

    _error_code(
        media_module._claimed_media(request, limited_settings).__enter__,
        "MEDIA_OVER_LIMIT",
    )
    assert list(limited_settings.work_root.iterdir()) == []


def test_claim_maps_cross_filesystem_copy_failure(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings.prepare_roots()
    (settings.staging_root / f"{STAGED_MEDIA_ID}.media").write_bytes(b"x")
    request = MediaValidationRequest.model_validate(request_body(1))

    def copy_failure(*_args: object, **_kwargs: object) -> None:
        raise OSError

    monkeypatch.setattr(media_module, "_copy_and_consume", copy_failure)
    _error_code(
        media_module._claimed_media(request, settings).__enter__,
        "INTERNAL_ERROR",
    )


def test_cross_filesystem_copy_rejects_a_nonregular_source(tmp_path: Path) -> None:
    source = tmp_path / "source.media"
    destination = tmp_path / "destination.media"
    source.mkdir()

    _error_code(
        lambda: media_module._copy_and_consume(source, destination, max_bytes=100),
        "UNSUPPORTED_MEDIA",
    )
    assert not source.exists()


def test_service_rejects_when_validation_capacity_is_exhausted(
    settings: ServiceSettings,
) -> None:
    limited = replace(
        settings,
        limits=replace(settings.limits, max_concurrent_validations=1),
    )
    service = MediaValidationService(limited)
    request = MediaValidationRequest.model_validate(request_body(1))
    assert service._admission.acquire(blocking=False)
    try:
        response = service.validate(request)
    finally:
        service._admission.release()

    assert response.outcome == "rejected"
    assert response.error.code == "SERVICE_BUSY"
    assert response.error.stage == "admission"


@pytest.mark.parametrize("manifest", [b"#EXTM3U\n", b"ffconcat version 1.0\n"])
def test_indirect_media_is_rejected_before_process_invocation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    manifest: bytes,
) -> None:
    media_path = tmp_path / "manifest.media"
    media_path.write_bytes(manifest)
    invoked = False

    def unexpected_process(*_args: object, **_kwargs: object) -> ProcessResult:
        nonlocal invoked
        invoked = True
        return ProcessResult(0, b"{}", b"", 0)

    monkeypatch.setattr(media_module, "run_bounded_process", unexpected_process)
    _error_code(
        lambda: media_module._reject_indirect_media(media_path),
        "UNSUPPORTED_MEDIA",
    )
    assert invoked is False


def test_parse_probe_rejects_unapproved_container_format(
    settings: ServiceSettings,
) -> None:
    probe = _valid_probe()
    cast("dict[str, object]", probe["format"])["format_name"] = "hls"

    _error_code(lambda: media_module._parse_probe(probe, settings))
