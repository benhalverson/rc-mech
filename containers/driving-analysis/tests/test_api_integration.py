import hashlib
import json
import subprocess
from dataclasses import replace
from pathlib import Path
from typing import Literal

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
    assert str(settings.staging_root) not in caplog.text
    assert STAGED_MEDIA_ID not in caplog.text
    assert checksum not in caplog.text
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
