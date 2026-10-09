import hashlib
import json
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from typing import Literal, cast

import pytest
from fastapi.testclient import TestClient

from driving_analysis_service.api import create_app
from driving_analysis_service.contracts import (
    AcceptedValidationResponse,
    HealthResponse,
    MediaFacts,
    MediaValidationRequest,
    RationalValue,
    RejectedValidationResponse,
    SafeError,
    StagedMediaInput,
)
from driving_analysis_service.safe_logging import LOGGER
from driving_analysis_service.settings import ServiceSettings
from tests.conftest import (
    CORRELATION_ID,
    STAGED_MEDIA_ID,
    VideoFactory,
    request_body,
    stage_media,
)

LimitName = Literal["max_bytes", "max_duration_ms", "max_width", "max_frames"]


def _client(settings: ServiceSettings) -> TestClient:
    return TestClient(create_app(settings))


def _assert_consumed_and_clean(settings: ServiceSettings) -> None:
    assert list(settings.staging_root.iterdir()) == []
    assert list(settings.work_root.iterdir()) == []


def test_health_reports_media_readiness(settings: ServiceSettings) -> None:
    with _client(settings) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "contractVersion": "race-video-validation.v1",
        "service": "driving-analysis-media",
        "status": "ready",
    }


def test_health_returns_safe_error_when_an_executable_is_missing(
    settings: ServiceSettings,
) -> None:
    unavailable = replace(settings, ffprobe_executable=settings.work_root / "missing")

    with _client(unavailable) as client:
        response = client.get("/health")

    assert response.status_code == 503
    assert response.json() == {
        "contractVersion": "race-video-validation.v1",
        "correlationId": None,
        "outcome": "rejected",
        "error": {
            "code": "SERVICE_UNAVAILABLE",
            "stage": "request",
            "message": "The media validation service is unavailable.",
        },
    }


def test_health_returns_safe_error_when_scratch_roots_cannot_be_prepared(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def deny_roots(_settings: ServiceSettings) -> None:
        raise PermissionError

    monkeypatch.setattr(ServiceSettings, "prepare_roots", deny_roots)
    with _client(settings) as client:
        response = client.get("/health")

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"


def test_probe_accepts_and_reports_real_media_facts(
    settings: ServiceSettings,
    accepted_video: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    byte_count = stage_media(settings, accepted_video)
    checksum = hashlib.sha256(accepted_video.read_bytes()).hexdigest()

    LOGGER.addHandler(caplog.handler)
    try:
        with _client(settings) as client:
            response = client.post(
                "/v1/media/probe",
                json=request_body(byte_count),
            )
    finally:
        LOGGER.removeHandler(caplog.handler)

    assert response.status_code == 200
    assert response.json() == {
        "contractVersion": "race-video-validation.v1",
        "correlationId": CORRELATION_ID,
        "outcome": "accepted",
        "media": {
            "byteCount": byte_count,
            "durationMs": 500,
            "width": 160,
            "height": 90,
            "videoCodec": "h264",
            "audioCodecs": [],
            "containerFormats": ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
            "decodedFrameCount": 5,
            "averageFrameRate": {"numerator": 10, "denominator": 1},
            "timeBase": {"numerator": 1, "denominator": 10240},
            "sampleAspectRatio": {"numerator": 1, "denominator": 1},
            "displayAspectRatio": {"numerator": 16, "denominator": 9},
            "startTimeMs": 0,
            "checksumSha256": checksum,
        },
    }
    log_event = json.loads(caplog.messages[-1])
    assert log_event == {
        "byteCount": byte_count,
        "correlationId": CORRELATION_ID,
        "decodedFrameCount": 5,
        "durationMs": 500,
        "elapsedMs": log_event["elapsedMs"],
        "event": "race_video_validation.stage",
        "height": 90,
        "outcome": "accepted",
        "stage": "complete",
        "videoCodec": "h264",
        "width": 160,
    }
    assert isinstance(log_event["elapsedMs"], int)
    assert 0 <= log_event["elapsedMs"] <= 10_000
    assert [
        (json.loads(message)["stage"], json.loads(message)["outcome"])
        for message in caplog.messages
    ] == [
        ("claim", "started"),
        ("inspect", "started"),
        ("decode", "started"),
        ("complete", "accepted"),
    ]
    assert str(settings.staging_root) not in caplog.text
    assert STAGED_MEDIA_ID not in caplog.text
    assert checksum not in caplog.text
    _assert_consumed_and_clean(settings)


def test_probe_atomically_consumes_one_staged_media_id(
    settings: ServiceSettings,
    accepted_video: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    byte_count = stage_media(settings, accepted_video)
    application = create_app(settings)
    rename_barrier = threading.Barrier(2)
    real_rename = Path.rename

    def simultaneous_rename(source: Path, destination: Path) -> Path:
        rename_barrier.wait(timeout=5)
        return real_rename(source, destination)

    monkeypatch.setattr(Path, "rename", simultaneous_rename)

    def request_probe() -> dict[str, object]:
        with TestClient(application) as client:
            response = client.post("/v1/media/probe", json=request_body(byte_count))
        return cast("dict[str, object]", response.json())

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _index: request_probe(), range(2)))

    def outcome(response: dict[str, object]) -> tuple[object, object | None]:
        error = response.get("error")
        code = error.get("code") if isinstance(error, dict) else None
        return response["outcome"], code

    assert sorted(outcome(response) for response in responses) == [
        ("accepted", None),
        ("rejected", "STAGED_MEDIA_NOT_FOUND"),
    ]
    _assert_consumed_and_clean(settings)


def test_probe_accepts_anamorphic_16_9_media(
    settings: ServiceSettings,
    tmp_path: Path,
) -> None:
    anamorphic = tmp_path / "anamorphic.mp4"
    subprocess.run(  # noqa: S603 - fixed test-only FFmpeg command
        (
            "/usr/bin/ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=144x90:r=10:d=0.5",
            "-vf",
            "setsar=10/9",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-y",
            str(anamorphic),
        ),
        check=True,
        capture_output=True,
    )
    byte_count = stage_media(settings, anamorphic)

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert response.json()["outcome"] == "accepted"
    assert response.json()["media"]["sampleAspectRatio"] == {
        "numerator": 10,
        "denominator": 9,
    }
    assert response.json()["media"]["displayAspectRatio"] == {
        "numerator": 16,
        "denominator": 9,
    }
    _assert_consumed_and_clean(settings)


@pytest.mark.parametrize(
    ("file_bytes", "expected_code", "expected_stage"),
    [
        (b"this is not media", "CORRUPT_MEDIA", "probe"),
        (b"", "CORRUPT_MEDIA", "inspect"),
    ],
)
def test_probe_rejects_corrupt_media_and_cleans_it(
    settings: ServiceSettings,
    tmp_path: Path,
    file_bytes: bytes,
    expected_code: str,
    expected_stage: str,
) -> None:
    source = tmp_path / "corrupt.bin"
    source.write_bytes(file_bytes)
    byte_count = stage_media(settings, source)

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(max(1, byte_count)))

    assert response.status_code == 200
    body = response.json()
    assert body["outcome"] == "rejected"
    assert body["error"]["code"] == expected_code
    assert body["error"]["stage"] == expected_stage
    _assert_consumed_and_clean(settings)


def test_probe_rejects_a_truncated_real_fixture(
    settings: ServiceSettings,
    accepted_video: Path,
    tmp_path: Path,
) -> None:
    original = accepted_video.read_bytes()
    truncated = tmp_path / "truncated.mp4"
    truncated.write_bytes(original[: len(original) // 2])
    byte_count = stage_media(settings, truncated)

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert response.status_code == 200
    assert response.json()["error"]["code"] == "CORRUPT_MEDIA"
    _assert_consumed_and_clean(settings)


def test_probe_rejects_wrong_layout(
    settings: ServiceSettings,
    video_factory: VideoFactory,
) -> None:
    wrong_layout = video_factory("wrong-layout.mp4", 160, 120, 0.5, "libx264")
    byte_count = stage_media(settings, wrong_layout)

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert response.json()["error"]["code"] == "INCOMPATIBLE_LAYOUT"
    _assert_consumed_and_clean(settings)


def test_probe_rejects_layout_change_during_decode(
    settings: ServiceSettings,
    video_factory: VideoFactory,
    tmp_path: Path,
) -> None:
    first = video_factory("first-layout.mp4", 160, 90, 0.5, "libx264")
    second = video_factory("second-layout.mp4", 160, 120, 0.5, "libx264")
    listing = tmp_path / "changing-layout.txt"
    listing.write_text(f"file '{first}'\nfile '{second}'\n")
    changing_layout = tmp_path / "changing-layout.mkv"
    subprocess.run(  # noqa: S603 - fixed test-only FFmpeg command
        (
            "/usr/bin/ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(listing),
            "-c",
            "copy",
            "-y",
            str(changing_layout),
        ),
        check=True,
        capture_output=True,
    )
    byte_count = stage_media(settings, changing_layout)

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert response.json()["error"] == {
        "code": "INCOMPATIBLE_LAYOUT",
        "stage": "decode",
        "message": "Every decoded frame must preserve the 16:9 layout.",
    }
    _assert_consumed_and_clean(settings)


def test_probe_rejects_rotation_change_during_decode(
    settings: ServiceSettings,
    video_factory: VideoFactory,
    tmp_path: Path,
) -> None:
    first = video_factory("first-orientation.mp4", 160, 90, 0.5, "libx264")
    second = video_factory("second-orientation.mp4", 160, 90, 0.5, "libx264")
    rotated = tmp_path / "rotated-second.mp4"
    subprocess.run(  # noqa: S603 - fixed test-only FFmpeg command
        (
            "/usr/bin/ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(second),
            "-c",
            "copy",
            "-bsf:v",
            "h264_metadata=display_orientation=insert:rotate=180",
            "-y",
            str(rotated),
        ),
        check=True,
        capture_output=True,
    )
    listing = tmp_path / "changing-orientation.txt"
    listing.write_text(f"file '{first}'\nfile '{rotated}'\n")
    changing_orientation = tmp_path / "changing-orientation.mkv"
    subprocess.run(  # noqa: S603 - fixed test-only FFmpeg command
        (
            "/usr/bin/ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(listing),
            "-c",
            "copy",
            "-y",
            str(changing_orientation),
        ),
        check=True,
        capture_output=True,
    )
    byte_count = stage_media(settings, changing_orientation)

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert response.json()["error"] == {
        "code": "INCOMPATIBLE_LAYOUT",
        "stage": "decode",
        "message": "Every decoded frame must preserve the 16:9 layout.",
    }


def test_probe_accepts_zero_degree_display_orientation(
    settings: ServiceSettings,
    video_factory: VideoFactory,
    tmp_path: Path,
) -> None:
    source = video_factory("zero-orientation-source.mp4", 160, 90, 0.5, "libx264")
    oriented = tmp_path / "zero-orientation.mp4"
    subprocess.run(  # noqa: S603 - fixed test-only FFmpeg command
        (
            "/usr/bin/ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-c",
            "copy",
            "-bsf:v",
            "h264_metadata=display_orientation=insert:rotate=0",
            "-y",
            str(oriented),
        ),
        check=True,
        capture_output=True,
    )
    byte_count = stage_media(settings, oriented)

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert response.json()["outcome"] == "accepted"
    _assert_consumed_and_clean(settings)


def test_probe_rejects_an_unsupported_real_codec(
    settings: ServiceSettings,
    video_factory: VideoFactory,
) -> None:
    unsupported = video_factory("unsupported.mkv", 160, 90, 0.5, "ffv1")
    byte_count = stage_media(settings, unsupported)

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert response.json()["error"]["code"] == "UNSUPPORTED_MEDIA"
    _assert_consumed_and_clean(settings)


def test_probe_rejects_a_valid_disallowed_container_as_unsupported(
    settings: ServiceSettings,
    video_factory: VideoFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    unsupported = video_factory("unsupported.avi", 160, 90, 0.5, "mpeg4")
    byte_count = stage_media(settings, unsupported)

    LOGGER.addHandler(caplog.handler)
    try:
        with _client(settings) as client:
            response = client.post("/v1/media/probe", json=request_body(byte_count))
    finally:
        LOGGER.removeHandler(caplog.handler)

    assert response.json()["error"] == {
        "code": "UNSUPPORTED_MEDIA",
        "stage": "probe",
        "message": "The media format or metadata is unsupported.",
    }
    assert str(unsupported) not in response.text
    assert str(unsupported) not in caplog.text
    assert str(settings.staging_root) not in caplog.text
    assert "pipe:0" not in caplog.text
    _assert_consumed_and_clean(settings)


@pytest.mark.parametrize(
    ("limit_name", "limit_value", "expected_stage"),
    [
        ("max_bytes", 1, "claim"),
        ("max_duration_ms", 100, "probe"),
        ("max_width", 100, "probe"),
        ("max_frames", 2, "probe"),
    ],
)
def test_probe_enforces_media_resource_limits(
    settings: ServiceSettings,
    accepted_video: Path,
    limit_name: LimitName,
    limit_value: int,
    expected_stage: str,
) -> None:
    byte_count = stage_media(settings, accepted_video)
    if limit_name == "max_bytes":
        limits = replace(settings.limits, max_bytes=limit_value)
    elif limit_name == "max_duration_ms":
        limits = replace(settings.limits, max_duration_ms=limit_value)
    elif limit_name == "max_width":
        limits = replace(settings.limits, max_width=limit_value)
    else:
        limits = replace(settings.limits, max_frames=limit_value)
    limited_settings = replace(settings, limits=limits)

    with _client(limited_settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert response.json()["error"] == {
        "code": "MEDIA_OVER_LIMIT",
        "stage": expected_stage,
        "message": response.json()["error"]["message"],
    }
    _assert_consumed_and_clean(settings)


def test_probe_rejects_expected_byte_mismatch(
    settings: ServiceSettings,
    accepted_video: Path,
) -> None:
    byte_count = stage_media(settings, accepted_video)

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count + 1))

    assert response.json()["error"]["code"] == "STAGED_MEDIA_MISMATCH"
    _assert_consumed_and_clean(settings)


def test_probe_rejects_missing_staged_media_and_cleans_workspace(
    settings: ServiceSettings,
) -> None:
    settings.prepare_roots()

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(1))

    assert response.json()["error"]["code"] == "STAGED_MEDIA_NOT_FOUND"
    _assert_consumed_and_clean(settings)


@pytest.mark.parametrize(
    "body",
    [
        {
            "contractVersion": "race-video-validation.v2",
            "correlationId": CORRELATION_ID,
            "input": {"stagedMediaId": STAGED_MEDIA_ID, "expectedByteCount": 1},
        },
        request_body(1, correlation_id="not-a-correlation-id"),
        request_body(1, staged_media_id="../../secret; rm -rf /"),
        {
            **request_body(1),
            "url": "https://example.com/video.mp4",
        },
        {
            **request_body(1),
            "r2Key": "owner/private/video",
        },
        {
            **request_body(1),
            "credentials": "secret",
        },
        {
            **request_body(1),
            "input": {
                "stagedMediaId": STAGED_MEDIA_ID,
                "expectedByteCount": "1",
            },
        },
    ],
)
def test_probe_rejects_values_outside_the_strict_contract(
    settings: ServiceSettings,
    body: dict[str, object],
) -> None:
    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=body)

    assert response.status_code == 422
    assert response.json() == {
        "contractVersion": "race-video-validation.v1",
        "correlationId": None,
        "outcome": "rejected",
        "error": {
            "code": "INVALID_REQUEST",
            "stage": "request",
            "message": "The request does not match the versioned contract.",
        },
    }
    assert "secret" not in response.text
    assert "example.com" not in response.text


def test_probe_maps_process_timeout_without_exposing_process_text(
    settings: ServiceSettings,
    accepted_video: Path,
    tmp_path: Path,
) -> None:
    byte_count = stage_media(settings, accepted_video)
    sleeper = tmp_path / "sleep"
    sleeper.write_text("#!/bin/sh\nsleep 2\necho private-provider-text >&2\n")
    sleeper.chmod(0o700)
    timeout_limits = replace(settings.limits, process_timeout_seconds=0.01)
    timeout_settings = replace(
        settings,
        ffprobe_executable=sleeper,
        limits=timeout_limits,
    )

    with _client(timeout_settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert response.json()["error"]["code"] == "PROCESS_TIMEOUT"
    assert "private-provider-text" not in response.text
    _assert_consumed_and_clean(settings)


def test_probe_maps_process_output_limit_without_exposing_output(
    settings: ServiceSettings,
    accepted_video: Path,
    tmp_path: Path,
) -> None:
    byte_count = stage_media(settings, accepted_video)
    noisy = tmp_path / "noisy"
    noisy.write_text("#!/bin/sh\nyes private-provider-text | head -c 4096\n")
    noisy.chmod(0o700)
    output_limits = replace(settings.limits, max_process_output_bytes=32)
    output_settings = replace(
        settings,
        ffprobe_executable=noisy,
        limits=output_limits,
    )

    with _client(output_settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert response.json()["error"]["code"] == "MEDIA_OVER_LIMIT"
    assert "private-provider-text" not in response.text
    _assert_consumed_and_clean(settings)


@pytest.mark.parametrize(
    "contract",
    [
        AcceptedValidationResponse,
        HealthResponse,
        MediaFacts,
        MediaValidationRequest,
        RationalValue,
        RejectedValidationResponse,
        SafeError,
        StagedMediaInput,
    ],
)
def test_contract_objects_are_closed(contract: type[object]) -> None:
    assert contract.model_json_schema()["additionalProperties"] is False  # type: ignore[attr-defined]


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_service_does_not_expose_documentation_routes(
    settings: ServiceSettings,
    path: str,
) -> None:
    with _client(settings) as client:
        response = client.get(path)

    assert response.status_code == 404


def test_probe_does_not_invoke_a_shell(
    settings: ServiceSettings,
    accepted_video: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    byte_count = stage_media(settings, accepted_video)
    real_popen = subprocess.Popen
    observed_shell_values: list[bool] = []

    def observe_popen(*args: object, **kwargs: object) -> subprocess.Popen[bytes]:
        observed_shell_values.append(bool(kwargs.get("shell")))
        return real_popen(*args, **kwargs)  # type: ignore[call-overload, no-any-return]

    monkeypatch.setattr(subprocess, "Popen", observe_popen)
    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert response.json()["outcome"] == "accepted"
    assert observed_shell_values == [False, False]


def test_staged_filename_is_derived_only_from_the_opaque_id(
    settings: ServiceSettings,
) -> None:
    settings.prepare_roots()
    unexpected = settings.staging_root / "not-the-request.media"
    unexpected.write_bytes(b"private")

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(7))

    assert response.json()["error"]["code"] == "STAGED_MEDIA_NOT_FOUND"
    assert unexpected.read_bytes() == b"private"


def test_probe_rejects_non_regular_staged_input(
    settings: ServiceSettings,
) -> None:
    settings.prepare_roots()
    staged_path = settings.staging_root / f"{STAGED_MEDIA_ID}.media"
    staged_path.mkdir()

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(1))

    assert response.json()["error"]["code"] == "UNSUPPORTED_MEDIA"
    _assert_consumed_and_clean(settings)


def test_probe_rejects_and_consumes_a_staged_fifo_without_blocking(
    settings: ServiceSettings,
) -> None:
    settings.prepare_roots()
    staged_path = settings.staging_root / f"{STAGED_MEDIA_ID}.media"
    os.mkfifo(staged_path)

    started_at = time.monotonic()
    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(1))

    assert time.monotonic() - started_at < 1
    _assert_consumed_and_clean(settings)
    assert response.json()["error"] == {
        "code": "UNSUPPORTED_MEDIA",
        "stage": "claim",
        "message": "The staged input is not a supported media file.",
    }


def test_probe_rejects_and_consumes_a_staged_symlink(
    settings: ServiceSettings,
    tmp_path: Path,
) -> None:
    settings.prepare_roots()
    target = tmp_path / "outside.media"
    target.write_bytes(b"private")
    staged_path = settings.staging_root / f"{STAGED_MEDIA_ID}.media"
    staged_path.symlink_to(target)

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(7))

    _assert_consumed_and_clean(settings)
    assert response.json()["error"] == {
        "code": "UNSUPPORTED_MEDIA",
        "stage": "claim",
        "message": "The staged input is not a supported media file.",
    }
    assert target.read_bytes() == b"private"


def test_probe_rejects_hls_that_references_media_outside_the_request(
    settings: ServiceSettings,
    tmp_path: Path,
) -> None:
    external_segment = tmp_path / "outside.ts"
    subprocess.run(  # noqa: S603 - fixed test-only FFmpeg command
        (
            "/usr/bin/ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=160x90:r=10:d=0.5",
            "-c:v",
            "libx264",
            "-f",
            "mpegts",
            "-y",
            str(external_segment),
        ),
        check=True,
        capture_output=True,
    )
    manifest = tmp_path / "attack.m3u8"
    manifest.write_text(
        "\n".join(
            (
                "#EXTM3U",
                "#EXT-X-VERSION:3",
                "#EXT-X-TARGETDURATION:1",
                "#EXTINF:0.5,",
                str(external_segment),
                "#EXT-X-ENDLIST",
            )
        )
    )
    byte_count = stage_media(settings, manifest)

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert response.json()["error"] == {
        "code": "UNSUPPORTED_MEDIA",
        "stage": "inspect",
        "message": "Indirect media manifests are unsupported.",
    }
    assert external_segment.exists()
    _assert_consumed_and_clean(settings)


def test_probe_classification_does_not_enable_embedded_network_protocols(
    settings: ServiceSettings,
    tmp_path: Path,
) -> None:
    session_description = tmp_path / "network-reference.sdp"
    session_description.write_text(
        """v=0
o=- 0 0 IN IP4 127.0.0.1
s=No Name
c=IN IP4 127.0.0.1
t=0 0
m=video 5004 RTP/AVP 96
a=rtpmap:96 H264/90000
"""
    )
    byte_count = stage_media(settings, session_description)
    bounded_settings = replace(
        settings,
        limits=replace(settings.limits, process_timeout_seconds=0.2),
    )

    started_at = time.monotonic()
    with _client(bounded_settings) as client:
        response = client.post("/v1/media/probe", json=request_body(byte_count))

    assert time.monotonic() - started_at < 1
    assert response.json()["error"] == {
        "code": "CORRUPT_MEDIA",
        "stage": "probe",
        "message": "The media could not be probed.",
    }
    _assert_consumed_and_clean(settings)


def test_probe_rejects_oversized_request_body_before_parsing(
    settings: ServiceSettings,
) -> None:
    oversized = {**request_body(1), "padding": "private" * 1024}

    with _client(settings) as client:
        response = client.post("/v1/media/probe", json=oversized)

    assert response.status_code == 413
    assert response.json()["error"] == {
        "code": "INVALID_REQUEST",
        "stage": "request",
        "message": "The request body exceeds the configured limit.",
    }
    assert "private" not in response.text
