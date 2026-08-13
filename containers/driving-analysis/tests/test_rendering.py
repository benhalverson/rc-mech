import hashlib
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from driving_analysis_service import processes as process_module
from driving_analysis_service import rendering
from driving_analysis_service.api import create_app
from driving_analysis_service.errors import MediaValidationError
from driving_analysis_service.inference import (
    FakeInferenceProvider,
    configuration_provenance,
)
from driving_analysis_service.media import ProbeMetadata
from driving_analysis_service.processes import (
    ProcessOutputLimitError,
    ProcessTimeoutError,
)
from driving_analysis_service.rendering_contracts import (
    RenderArtifact,
    RenderSpecification,
    RenderStageAccepted,
    RenderStageRequest,
)
from driving_analysis_service.settings import InferenceSettings, ServiceSettings
from driving_analysis_service.tracking_artifacts import (
    ArtifactConflictError,
    InvalidArtifactError,
    canonical_json,
)
from tests.conftest import stage_media

# Commands use fixed absolute test executables and generated temporary paths.
# ruff: noqa: EM101, S603, TRY003

RENDER_ID = "d2cc64b0-3a7d-4f84-a1b4-fdb852e0c44a"
CORRELATION_ID = "c3d1ea64-7c62-4a1e-a41f-43fe101b7f41"
STAGED_ID = "09e32fc7-6bdd-4bc2-852c-fc29329e58d6"
SHA = "a" * 64


def _video(
    tmp_path: Path, *, non_zero_start: bool = False, with_audio: bool = True
) -> Path:
    output = tmp_path / "render-source.mp4"
    timestamp_arguments = ("-output_ts_offset", "2") if non_zero_start else ()
    audio_input_arguments = (
        (
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=2",
        )
        if with_audio
        else ()
    )
    audio_output_arguments = ("-shortest", "-c:a", "aac") if with_audio else ()
    subprocess.run(
        (
            "/usr/bin/ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=160x90:r=10:d=2",
            *audio_input_arguments,
            *timestamp_arguments,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            *audio_output_arguments,
            "-movflags",
            "+faststart",
            "-y",
            str(output),
        ),
        check=True,
        capture_output=True,
    )
    return output


def _body(  # noqa: PLR0913 - test request builder exposes contract fields explicitly
    byte_count: int,
    checksum: str,
    *,
    render_id: str = RENDER_ID,
    entry_timestamp_ms: int = 500,
    exit_timestamp_ms: int = 1000,
    max_output_bytes: int = 2 * 1024 * 1024,
    correlation_id: str = CORRELATION_ID,
    staged_media_id: str = STAGED_ID,
) -> dict[str, object]:
    return {
        "contractVersion": "corner-render.v1",
        "correlationId": correlation_id,
        "caseId": "case-1",
        "renderId": render_id,
        "input": {
            "stagedMediaId": staged_media_id,
            "expectedByteCount": byte_count,
        },
        "specification": {
            "sourceChecksumSha256": checksum,
            "runId": "run-1",
            "trackMapVersion": "map-1",
            "cornerId": "corner-1",
            "cornerView": {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5},
            "entryTimestampMs": entry_timestamp_ms,
            "exitTimestampMs": exit_timestamp_ms,
            "padding": {"beforeMs": 500, "afterMs": 500},
            "overlay": {
                "subjectCenter": {"x": 0.5, "y": 0.5},
                "entryGate": {
                    "entry": {"x": 0.3, "y": 0.4},
                    "exit": {"x": 0.3, "y": 0.6},
                    "direction": "positive",
                },
                "exitGate": {
                    "entry": {"x": 0.7, "y": 0.4},
                    "exit": {"x": 0.7, "y": 0.6},
                    "direction": "positive",
                },
            },
            "maxOutputBytes": max_output_bytes,
            "pipelineVersion": "corner-render.v1",
        },
    }


def _client(settings: ServiceSettings) -> TestClient:
    provider = FakeInferenceProvider(
        configuration_provenance(InferenceSettings(provider="fake"))
    )
    return TestClient(create_app(settings, provider))


def _metadata(*, duration_ms: int = 1000) -> ProbeMetadata:
    return ProbeMetadata(
        duration_ms=duration_ms,
        width=160,
        height=90,
        video_stream_index=0,
        video_codec="h264",
        audio_codecs=(),
        container_formats=("mp4",),
        average_frame_rate=Fraction(10, 1),
        time_base=Fraction(1, 10),
        sample_aspect_ratio=Fraction(1, 1),
        display_aspect_ratio=Fraction(16, 9),
        start_time_ms=0,
    )


def test_render_contract_requires_fixed_padding_and_ordered_timestamps() -> None:
    try:
        RenderSpecification.model_validate(
            {
                "sourceChecksumSha256": SHA,
                "runId": "run-1",
                "trackMapVersion": "map-1",
                "cornerId": "corner-1",
                "cornerView": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
                "entryTimestampMs": 1000,
                "exitTimestampMs": 500,
                "padding": {"beforeMs": 250, "afterMs": 500},
                "overlay": {
                    "subjectCenter": {"x": 0.5, "y": 0.5},
                    "entryGate": {
                        "entry": {"x": 0.1, "y": 0.1},
                        "exit": {"x": 0.2, "y": 0.2},
                        "direction": "positive",
                    },
                    "exitGate": {
                        "entry": {"x": 0.3, "y": 0.3},
                        "exit": {"x": 0.4, "y": 0.4},
                        "direction": "positive",
                    },
                },
                "maxOutputBytes": 1000,
                "pipelineVersion": "corner-render.v1",
            }
        )
    except ValidationError:
        pass
    else:
        raise AssertionError("invalid render specification was accepted")


def test_render_produces_cropped_h264_clip_and_recovers_identical_retry(
    settings: ServiceSettings,
    tmp_path: Path,
) -> None:
    source = _video(tmp_path)
    source_probe = subprocess.run(
        (
            "/usr/bin/ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(source),
        ),
        check=True,
        capture_output=True,
        text=True,
    )
    assert source_probe.stdout.splitlines() == ["video", "audio"]
    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    byte_count = stage_media(settings, source)

    with _client(settings) as client:
        first = client.post("/v1/stages/render", json=_body(byte_count, checksum))
        assert first.status_code == 200, first.text
        assert first.json()["outcome"] == "accepted", first.text
        second = client.post(
            "/v1/stages/render",
            json=_body(
                byte_count,
                checksum,
                correlation_id="a3d1ea64-7c62-4a1e-a41f-43fe101b7f41",
                staged_media_id="19e32fc7-6bdd-4bc2-852c-fc29329e58d6",
            ),
        )

    assert first.status_code == 200
    assert first.json()["artifact"] == second.json()["artifact"]
    assert second.json()["correlationId"] != first.json()["correlationId"]
    response = first.json()
    assert response["outcome"] == "accepted"
    assert response["artifact"]["contentType"] == "video/mp4"
    gate_to_gate_duration_ms = 1000 - 500
    expected_clip_duration_ms = 500 + gate_to_gate_duration_ms + 500
    assert response["artifact"]["durationMs"] == expected_clip_duration_ms
    assert response["artifact"]["durationMs"] - 1000 == gate_to_gate_duration_ms
    artifact = (
        settings.artifact_root / f"{RENDER_ID}.corner" / f"{RENDER_ID}.corner.mp4"
    )
    probe = subprocess.run(
        (
            "/usr/bin/ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height",
            "-of",
            "json",
            str(artifact),
        ),
        check=True,
        capture_output=True,
        text=True,
    )
    assert '"codec_name": "h264"' in probe.stdout
    assert '"width": 80' in probe.stdout
    # yuv420p requires even dimensions, so the 45px normalized height is
    # rounded down by FFmpeg's crop filter.
    assert '"height": 44' in probe.stdout
    assert '"codec_type": "audio"' not in probe.stdout
    frame = subprocess.run(
        (
            "/usr/bin/ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(artifact),
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ),
        check=True,
        capture_output=True,
    ).stdout
    pixels = tuple(zip(frame[0::3], frame[1::3], frame[2::3], strict=True))

    def pixel(x: int, y: int) -> tuple[int, int, int]:
        return pixels[y * 80 + x]

    def region(
        x_start: int, x_end: int, y_start: int, y_end: int
    ) -> tuple[tuple[int, int, int], ...]:
        return tuple(
            pixel(candidate_x, candidate_y)
            for candidate_x in range(x_start, x_end)
            for candidate_y in range(y_start, y_end)
        )

    entry_gate = region(4, 13, 8, 36)
    exit_gate = region(67, 76, 8, 36)
    subject = region(32, 49, 13, 31)
    assert any(
        red > 120 and green > 120 and blue < 120 for red, green, blue in entry_gate
    )
    assert any(
        red < 120 and green > 120 and blue > 120 for red, green, blue in exit_gate
    )
    assert any(red > 160 and green > 160 and blue > 160 for red, green, blue in subject)


def test_render_rejects_source_checksum_mismatch(
    settings: ServiceSettings,
    tmp_path: Path,
) -> None:
    source = _video(tmp_path)
    byte_count = stage_media(settings, source)
    with _client(settings) as client:
        response = client.post("/v1/stages/render", json=_body(byte_count, SHA))

    assert response.json()["error"] == {
        "code": "MEDIA_UNAVAILABLE",
        "stage": "render",
        "message": "render media unavailable",
    }


def test_render_rejects_corrupt_staged_media(
    settings: ServiceSettings,
    tmp_path: Path,
) -> None:
    source = tmp_path / "corrupt.media"
    source.write_bytes(b"not a video")
    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    byte_count = stage_media(settings, source)
    with _client(settings) as client:
        response = client.post(
            "/v1/stages/render",
            json=_body(
                byte_count,
                checksum,
                render_id="e0000000-0000-4000-8000-000000000000",
            ),
        )
    assert response.json()["error"]["code"] == "MEDIA_UNAVAILABLE"


@pytest.mark.parametrize(
    ("render_id", "entry_timestamp_ms", "exit_timestamp_ms"),
    [
        ("ffffffff-4444-4aaa-8bbb-cccccccccccc", 0, 500),
        ("eeeeeeee-4444-4aaa-8bbb-cccccccccccc", 1500, 2000),
    ],
)
def test_render_clamps_padding_at_real_source_boundaries(
    settings: ServiceSettings,
    tmp_path: Path,
    render_id: str,
    entry_timestamp_ms: int,
    exit_timestamp_ms: int,
) -> None:
    source = _video(tmp_path)
    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    byte_count = stage_media(settings, source)
    body = _body(
        byte_count,
        checksum,
        render_id=render_id,
        entry_timestamp_ms=entry_timestamp_ms,
        exit_timestamp_ms=exit_timestamp_ms,
    )
    with _client(settings) as client:
        response = client.post("/v1/stages/render", json=body)
    assert response.json()["outcome"] == "accepted", response.text
    assert response.json()["artifact"]["durationMs"] == 1000


def test_render_enforces_output_limit_during_real_ffmpeg_run(
    settings: ServiceSettings,
    tmp_path: Path,
) -> None:
    source = _video(tmp_path)
    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    byte_count = stage_media(settings, source)
    with _client(settings) as client:
        response = client.post(
            "/v1/stages/render",
            json=_body(
                byte_count,
                checksum,
                render_id="a0000000-0000-4000-8000-000000000000",
                max_output_bytes=1024,
            ),
        )
    assert response.json()["outcome"] == "rejected"
    assert response.json()["error"]["code"] == "RESOURCE_LIMIT"
    assert not (
        settings.artifact_root / "a0000000-0000-4000-8000-000000000000.corner"
    ).exists()


def test_real_ffmpeg_render_process_honors_deadline(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "blocking.mp4"
    os.mkfifo(source)
    request = RenderStageRequest.model_validate(_body(1, SHA))
    metadata = ProbeMetadata(
        duration_ms=2000,
        width=160,
        height=90,
        video_stream_index=0,
        video_codec="h264",
        audio_codecs=(),
        container_formats=("mp4",),
        average_frame_rate=Fraction(10, 1),
        time_base=Fraction(1, 10),
        sample_aspect_ratio=Fraction(1, 1),
        display_aspect_ratio=Fraction(16, 9),
        start_time_ms=0,
    )
    process_started = False
    original_enter = process_module._ProcessScope.__enter__

    def observe_process_start(
        scope: process_module._ProcessScope,
    ) -> subprocess.Popen[bytes]:
        nonlocal process_started
        process_started = True
        return original_enter(scope)

    monkeypatch.setattr(
        process_module._ProcessScope, "__enter__", observe_process_start
    )
    destination = tmp_path / "timed-out.mp4"
    with pytest.raises(ProcessTimeoutError):
        rendering._render_clip(
            source,
            destination,
            request.specification,
            metadata,
            settings,
            time.monotonic() + 0.05,
        )
    assert process_started is True
    assert not destination.exists()


def test_render_handles_real_non_zero_source_timestamps(
    settings: ServiceSettings,
    tmp_path: Path,
) -> None:
    source = _video(tmp_path, non_zero_start=True)
    source_probe = subprocess.run(
        (
            "/usr/bin/ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=start_time",
            "-select_streams",
            "v:0",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(source),
        ),
        check=True,
        capture_output=True,
        text=True,
    )
    assert source_probe.stdout.strip() == "2.000000"
    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    byte_count = stage_media(settings, source)
    with _client(settings) as client:
        response = client.post(
            "/v1/stages/render",
            json=_body(
                byte_count,
                checksum,
                render_id="b0000000-0000-4000-8000-000000000000",
            ),
        )
    assert response.json()["outcome"] == "accepted", response.text
    assert response.json()["artifact"]["durationMs"] == 1500


def test_real_ffmpeg_reencoding_is_byte_deterministic(
    settings: ServiceSettings,
    tmp_path: Path,
) -> None:
    source = _video(tmp_path)
    request = RenderStageRequest.model_validate(_body(source.stat().st_size, SHA))
    first = tmp_path / "first.mp4"
    second = tmp_path / "second.mp4"

    rendering._render_clip(
        source,
        first,
        request.specification,
        _metadata(duration_ms=2000),
        settings,
        time.monotonic() + 10,
    )
    rendering._render_clip(
        source,
        second,
        request.specification,
        _metadata(duration_ms=2000),
        settings,
        time.monotonic() + 10,
    )

    assert first.read_bytes() == second.read_bytes()


def test_render_supports_filter_special_characters_in_work_root(
    settings: ServiceSettings,
    tmp_path: Path,
) -> None:
    special_settings = replace(
        settings,
        work_root=tmp_path / "work:comma,[bracket];quote'backslash\\ space",
    )
    source = _video(tmp_path)
    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    byte_count = stage_media(special_settings, source)
    with _client(special_settings) as client:
        response = client.post(
            "/v1/stages/render",
            json=_body(
                byte_count,
                checksum,
                render_id="d0000000-0000-4000-8000-000000000000",
            ),
        )
    assert response.json()["outcome"] == "accepted", response.text


def test_render_request_validation_uses_render_contract(
    settings: ServiceSettings,
) -> None:
    with _client(settings) as client:
        response = client.post("/v1/stages/render", json={"unexpected": True})

    assert response.status_code == 422
    assert response.json()["error"] == {
        "code": "INVALID_REQUEST",
        "stage": "request",
        "message": "render request rejected",
    }


def test_render_rejects_overlay_outside_corner_view_at_endpoint(
    settings: ServiceSettings,
) -> None:
    body = _body(1, SHA)
    specification = cast("dict[str, object]", body["specification"])
    specification["overlay"] = {
        "subjectCenter": {"x": 0.1, "y": 0.5},
        "entryGate": {
            "entry": {"x": 0.3, "y": 0.4},
            "exit": {"x": 0.3, "y": 0.6},
            "direction": "positive",
        },
        "exitGate": {
            "entry": {"x": 0.7, "y": 0.4},
            "exit": {"x": 0.7, "y": 0.6},
            "direction": "positive",
        },
    }
    with _client(settings) as client:
        response = client.post("/v1/stages/render", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


@pytest.mark.parametrize(
    "failure",
    [
        ArtifactConflictError,
        ProcessTimeoutError,
        ProcessOutputLimitError,
        rendering.RenderProcessError,
        ValueError,
    ],
)
def test_render_maps_processing_failures_to_safe_errors(
    settings: ServiceSettings,
    failure: type[Exception],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = RenderStageRequest.model_validate(_body(1, SHA))
    service = rendering.CornerRenderService(settings)

    def fail(*_args: object, **_kwargs: object) -> object:
        raise failure

    monkeypatch.setattr(service, "_render", fail)
    response = service.render(request)

    assert response.outcome == "rejected"
    expected = {
        ArtifactConflictError: "ARTIFACT_CONFLICT",
        ProcessTimeoutError: "PROCESS_TIMEOUT",
        ProcessOutputLimitError: "RESOURCE_LIMIT",
        rendering.RenderProcessError: "RENDER_FAILED",
        ValueError: "RENDER_FAILED",
    }[failure]
    assert response.error.code == expected


def test_render_rejects_when_processing_admission_is_full(
    settings: ServiceSettings,
) -> None:
    admission = threading.BoundedSemaphore(0)
    service = rendering.CornerRenderService(settings, admission)
    response = service.render(RenderStageRequest.model_validate(_body(1, SHA)))
    assert response.outcome == "rejected"
    assert response.error.code == "SERVICE_BUSY"


def test_render_maps_media_timeout_to_timeout_error(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = rendering.CornerRenderService(settings)
    request = RenderStageRequest.model_validate(_body(1, SHA))

    def fail(*_args: object, **_kwargs: object) -> object:
        raise MediaValidationError(
            code="PROCESS_TIMEOUT",
            stage="probe",
            safe_message="render timed out",
        )

    monkeypatch.setattr(service, "_render", fail)
    response = service.render(request)
    assert response.outcome == "rejected"
    assert response.error.code == "PROCESS_TIMEOUT"


def test_render_validation_clamps_padding_at_source_boundaries() -> None:
    request = RenderStageRequest.model_validate(_body(1, SHA))
    rendering._validate_specification(request.specification, 1, _metadata())
    with pytest.raises(rendering.RenderInvalidMediaError):
        rendering._validate_specification(request.specification, 0, _metadata())
    with pytest.raises(rendering.RenderInvalidMediaError):
        rendering._validate_specification(
            request.specification, 1, _metadata(duration_ms=900)
        )


def test_gate_overlay_supports_diagonal_and_axis_aligned_gates() -> None:
    diagonal = rendering._ass_line(((8, 4), (32, 20)), "&H00FFFF&")
    vertical = rendering._ass_line(((8, 4), (8, 20)), "&HFFFF00&")
    assert "m 8 4 l 32 20" in diagonal
    assert "m 8 4 l 8 20" in vertical


def test_overlay_coordinates_follow_even_pixel_crop_rounding() -> None:
    request = RenderStageRequest.model_validate(_body(1, SHA))
    metadata = _metadata(duration_ms=2000)
    crop = rendering._pixel_crop(request.specification, metadata)
    assert crop == rendering._PixelCrop(width=80, height=44, x=40, y=22)
    assert rendering._pixel_gate(
        request.specification.overlay.entry_gate, metadata, crop
    ) == ((8, 14), (8, 32))
    assert rendering._pixel_point(
        request.specification.overlay.subject_center, metadata, crop
    ) == (40, 23)


def test_render_removes_partial_overlay_when_script_write_fails(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = RenderStageRequest.model_validate(_body(1, SHA))
    destination = tmp_path / "output.mp4"
    overlay = destination.with_suffix(".ass")
    original_write_text = Path.write_text

    def fail_after_partial_write(path: Path, *_args: object, **_kwargs: object) -> int:
        original_write_text(path, "partial", encoding="utf-8")
        raise OSError("fixture write failure")

    monkeypatch.setattr(Path, "write_text", fail_after_partial_write)
    with pytest.raises(OSError, match="fixture write failure"):
        rendering._render_clip(
            tmp_path / "source.mp4",
            destination,
            request.specification,
            _metadata(),
            settings,
            time.monotonic() + 10,
        )
    assert not overlay.exists()
    assert not destination.exists()


def test_render_recovery_rejects_tampered_completion_or_media(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = RenderStageRequest.model_validate(_body(1, SHA))
    settings.prepare_roots()
    bundle = settings.artifact_root / f"{RENDER_ID}.corner"
    bundle.mkdir()
    media = b"clip"
    (bundle / f"{RENDER_ID}.corner.mp4").write_bytes(media)
    monkeypatch.setattr(rendering, "_output_duration", lambda *_args: 1000)
    artifact = RenderArtifact(
        renderId=RENDER_ID,
        caseId="different-case",
        contentType="video/mp4",
        byteCount=len(media),
        checksumSha256=hashlib.sha256(media).hexdigest(),
        durationMs=1000,
        renderInputDigest=rendering._render_input_digest(request, "6.1"),
        sourceChecksumSha256=SHA,
        ffmpegVersion="6.1",
        pipelineVersion="corner-render.v1",
        elapsedMs=1,
    )
    (bundle / f"{RENDER_ID}.corner.json").write_bytes(
        canonical_json(artifact.model_dump(mode="json", by_alias=True))
    )
    with pytest.raises(ArtifactConflictError):
        rendering._recover(request, settings, time.monotonic() + 10)
    artifact = artifact.model_copy(update={"case_id": request.case_id})
    (bundle / f"{RENDER_ID}.corner.json").write_bytes(
        canonical_json(artifact.model_dump(mode="json", by_alias=True))
    )
    (bundle / f"{RENDER_ID}.corner.mp4").write_bytes(b"tampered")
    with pytest.raises(InvalidArtifactError):
        rendering._recover(request, settings, time.monotonic() + 10)
    artifact = artifact.model_copy(update={"duration_ms": 999})
    (bundle / f"{RENDER_ID}.corner.mp4").write_bytes(media)
    (bundle / f"{RENDER_ID}.corner.json").write_bytes(
        canonical_json(artifact.model_dump(mode="json", by_alias=True))
    )
    with pytest.raises(ArtifactConflictError):
        rendering._recover(request, settings, time.monotonic() + 10)


def test_render_recovery_returns_none_without_completion(
    settings: ServiceSettings,
) -> None:
    settings.prepare_roots()
    request = RenderStageRequest.model_validate(_body(1, SHA))
    (settings.artifact_root / f"{RENDER_ID}.corner").mkdir()
    assert rendering._recover(request, settings, 10.0) is None


def test_render_maps_malformed_recovery_artifact_to_safe_error(
    settings: ServiceSettings,
) -> None:
    settings.prepare_roots()
    request = RenderStageRequest.model_validate(_body(1, SHA))
    bundle = settings.artifact_root / f"{RENDER_ID}.corner"
    bundle.mkdir()
    (bundle / f"{RENDER_ID}.corner.json").write_bytes(b"{")
    response = rendering.CornerRenderService(settings).render(request)
    assert response.outcome == "rejected"
    assert response.error.code == "RENDER_FAILED"


def test_ffmpeg_and_probe_metadata_failures_are_safe(
    settings: ServiceSettings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = RenderStageRequest.model_validate(_body(1, SHA))

    monkeypatch.setattr(
        rendering,
        "run_bounded_process",
        lambda *_args, **_kwargs: SimpleNamespace(return_code=1, stdout=b""),
    )
    with pytest.raises(rendering.RenderInvalidMediaError):
        rendering._ffmpeg_version(settings, time.monotonic() + 10)
    with pytest.raises(rendering.RenderInvalidMediaError):
        rendering._output_duration(Path("missing"), settings, time.monotonic() + 10)
    monkeypatch.setattr(
        rendering,
        "run_bounded_process",
        lambda *_args, **_kwargs: SimpleNamespace(return_code=0, stdout=b"bad"),
    )
    with pytest.raises(rendering.RenderInvalidMediaError):
        rendering._ffmpeg_version(settings, time.monotonic() + 10)

    monkeypatch.setattr(
        rendering,
        "run_bounded_process",
        lambda *_args, **_kwargs: SimpleNamespace(
            return_code=0, stdout=b"not version 1"
        ),
    )
    with pytest.raises(rendering.RenderInvalidMediaError):
        rendering._ffmpeg_version(settings, time.monotonic() + 10)
    with pytest.raises(rendering.RenderInvalidMediaError):
        rendering._output_duration(Path("missing"), settings, time.monotonic() + 10)
    monkeypatch.setattr(
        rendering,
        "run_bounded_process",
        lambda *_args, **_kwargs: SimpleNamespace(return_code=0, stdout=b"0"),
    )
    with pytest.raises(rendering.RenderInvalidMediaError):
        rendering._output_duration(Path("missing"), settings, time.monotonic() + 10)
    assert request.specification.pipeline_version == "corner-render.v1"


def test_render_rejects_failed_ffmpeg_process(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = RenderStageRequest.model_validate(_body(1, SHA))
    monkeypatch.setattr(
        rendering,
        "run_bounded_process",
        lambda *_args, **_kwargs: SimpleNamespace(return_code=1, stdout=b""),
    )
    metadata = ProbeMetadata(
        duration_ms=1000,
        width=160,
        height=90,
        video_stream_index=0,
        video_codec="h264",
        audio_codecs=(),
        container_formats=("mp4",),
        average_frame_rate=Fraction(10, 1),
        time_base=Fraction(1, 10),
        sample_aspect_ratio=Fraction(1, 1),
        display_aspect_ratio=Fraction(16, 9),
        start_time_ms=0,
    )
    with pytest.raises(rendering.RenderProcessError):
        rendering._render_clip(
            tmp_path / "input.mp4",
            tmp_path / "output.mp4",
            request.specification,
            metadata,
            settings,
            time.monotonic() + 10,
        )


def test_render_rejects_subpixel_corner_view_before_ffmpeg(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _video(tmp_path)
    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    byte_count = stage_media(settings, source)
    body = _body(byte_count, checksum)
    specification = cast("dict[str, object]", body["specification"])
    specification["cornerView"] = {
        "x": 0.0,
        "y": 0.0,
        "width": 0.001,
        "height": 0.001,
    }
    specification["overlay"] = {
        "subjectCenter": {"x": 0.0005, "y": 0.0005},
        "entryGate": {
            "entry": {"x": 0.0002, "y": 0.0002},
            "exit": {"x": 0.0002, "y": 0.0008},
            "direction": "positive",
        },
        "exitGate": {
            "entry": {"x": 0.0008, "y": 0.0002},
            "exit": {"x": 0.0008, "y": 0.0008},
            "direction": "positive",
        },
    }

    def unexpected_ffmpeg(*_args: object, **_kwargs: object) -> str:
        raise AssertionError("FFmpeg was invoked before crop validation")

    monkeypatch.setattr(rendering, "_ffmpeg_version", unexpected_ffmpeg)
    with _client(settings) as client:
        response = client.post("/v1/stages/render", json=body)
    assert response.json()["outcome"] == "rejected"
    assert response.json()["error"]["code"] == "MEDIA_UNAVAILABLE"


def test_render_publish_race_recovers_verified_artifact(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _video(tmp_path)
    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    byte_count = stage_media(settings, source)
    request = RenderStageRequest.model_validate(_body(byte_count, checksum))
    calls = 0
    captured: dict[str, dict[str, bytes]] = {}

    recover_mode = "artifact"

    def recover(*_args: object, **_kwargs: object) -> RenderArtifact | None:
        nonlocal calls
        calls += 1
        if calls == 1:
            return None
        if recover_mode == "none":
            return None
        members = captured["members"]
        artifact = RenderArtifact.model_validate_json(
            members[f"{RENDER_ID}.corner.json"]
        )
        return artifact.model_copy(update={"elapsed_ms": artifact.elapsed_ms + 1})

    def publish(
        _destination: Path, members: dict[str, Path | bytes], **_kwargs: object
    ) -> bool:
        captured["members"] = {
            name: value if isinstance(value, bytes) else value.read_bytes()
            for name, value in members.items()
        }
        return False

    monkeypatch.setattr(rendering, "_recover", recover)
    monkeypatch.setattr(rendering, "publish_bundle", publish)
    response = rendering.CornerRenderService(settings).render(request)
    assert response.outcome == "accepted"
    published = RenderArtifact.model_validate_json(
        captured["members"][f"{RENDER_ID}.corner.json"]
    )
    assert response.artifact.elapsed_ms == published.elapsed_ms + 1
    recover_mode = "none"
    stage_media(settings, source)
    rejected = rendering.CornerRenderService(settings).render(request)
    assert rejected.outcome == "rejected"
    assert rejected.error.code == "ARTIFACT_CONFLICT"


def test_concurrent_identical_renders_use_isolated_scratch_and_one_artifact(
    settings: ServiceSettings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    concurrent_settings = replace(
        settings,
        limits=replace(settings.limits, max_concurrent_processing=2),
    )
    source = _video(tmp_path)
    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    byte_count = stage_media(concurrent_settings, source)
    second_staged_id = "19e32fc7-6bdd-4bc2-852c-fc29329e58d6"
    stage_media(
        concurrent_settings,
        source,
        staged_media_id=second_staged_id,
    )
    requests = (
        RenderStageRequest.model_validate(_body(byte_count, checksum)),
        RenderStageRequest.model_validate(
            _body(
                byte_count,
                checksum,
                correlation_id="a3d1ea64-7c62-4a1e-a41f-43fe101b7f41",
                staged_media_id=second_staged_id,
            )
        ),
    )
    barrier = threading.Barrier(2)
    destinations: list[Path] = []
    destination_lock = threading.Lock()
    original_render_clip = rendering._render_clip

    def synchronized_render_clip(  # noqa: PLR0913 - mirrors render seam
        source_path: Path,
        destination: Path,
        specification: RenderSpecification,
        metadata: ProbeMetadata,
        service_settings: ServiceSettings,
        deadline: float,
    ) -> None:
        with destination_lock:
            destinations.append(destination)
        barrier.wait(timeout=5)
        original_render_clip(
            source_path,
            destination,
            specification,
            metadata,
            service_settings,
            deadline,
        )

    monkeypatch.setattr(rendering, "_render_clip", synchronized_render_clip)
    service = rendering.CornerRenderService(concurrent_settings)
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = tuple(executor.map(service.render, requests))

    assert all(response.outcome == "accepted" for response in responses)
    accepted = [cast("RenderStageAccepted", response) for response in responses]
    assert accepted[0].artifact == accepted[1].artifact
    assert len({destination.parent for destination in destinations}) == 2


def test_render_contract_rejects_reverse_and_overlong_intervals() -> None:
    base = cast("dict[str, object]", _body(1, SHA)["specification"])
    reverse = dict(base)
    reverse["exitTimestampMs"] = 500
    with pytest.raises(ValidationError):
        RenderSpecification.model_validate(reverse)
    overlong = dict(base)
    overlong["exitTimestampMs"] = 1_000_000
    with pytest.raises(ValidationError):
        RenderSpecification.model_validate(overlong)
