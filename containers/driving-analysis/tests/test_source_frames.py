import base64
import hashlib
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from driving_analysis_service.api import create_app
from driving_analysis_service.settings import ServiceSettings
from tests.conftest import STAGED_MEDIA_ID, VideoFactory, stage_media


def frame_request(settings: ServiceSettings, source: Path) -> dict[str, object]:
    return {
        "contractVersion": "source-frame.v1",
        "input": {
            "stagedMediaId": STAGED_MEDIA_ID,
            "expectedByteCount": stage_media(settings, source),
        },
        "sourceChecksumSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "selection": {"kind": "timestamp", "timestampMs": 125},
        "includeImage": True,
    }


def test_timestamp_selects_first_actual_source_frame(
    settings: ServiceSettings, accepted_video: Path
) -> None:
    response = TestClient(create_app(settings)).post(
        "/v1/frames/select", json=frame_request(settings, accepted_video)
    )
    assert response.status_code == 200
    body = response.json()
    assert (body["frameIndex"], body["timestampMs"]) == (2, 200)
    assert base64.b64decode(body["imageBase64"]).startswith(b"\xff\xd8")
    assert list(settings.work_root.iterdir()) == []


@pytest.mark.parametrize("offset", [0, 5])
def test_vfr_exact_indices_and_relative_pts(
    settings: ServiceSettings, video_factory: VideoFactory, tmp_path: Path, offset: int
) -> None:
    source = video_factory("source.mp4", 160, 90, 1, "libx264")
    target = tmp_path / "vfr.mp4"
    subprocess.run(  # noqa: S603 - fixed hermetic fixture
        (
            "/usr/bin/ffmpeg",
            "-v",
            "error",
            "-i",
            str(source),
            "-vf",
            f"select='eq(n,0)+eq(n,2)+eq(n,5)+eq(n,9)',setpts=PTS+{offset}/TB",
            "-vsync",
            "vfr",
            "-c:v",
            "libx264",
            str(target),
        ),
        check=True,
        capture_output=True,
    )
    client = TestClient(create_app(settings))
    request = frame_request(settings, target)
    request["selection"] = {"kind": "timestamp", "timestampMs": 250}
    request["includeImage"] = False
    response = client.post("/v1/frames/select", json=request)
    assert response.status_code == 200, response.text
    assert response.json()["frameIndex"] == 2
    assert response.json()["timestampMs"] == 500
    assert response.json()["imageBase64"] is None
    request = frame_request(settings, target)
    request["selection"] = {"kind": "frame", "frameIndex": 3}
    response = client.post("/v1/frames/select", json=request)
    assert response.status_code == 200, response.text
    assert response.json()["timestampMs"] == 900


@pytest.mark.parametrize(
    "mutation", ["checksum", "missing", "bytes", "range", "schema"]
)
def test_rejected_selection_is_safe(
    settings: ServiceSettings, accepted_video: Path, mutation: str
) -> None:
    request = frame_request(settings, accepted_video)
    expected = "FRAME_UNAVAILABLE"
    if mutation == "checksum":
        request["sourceChecksumSha256"] = "a" * 64
        expected = "SOURCE_MISMATCH"
    elif mutation == "missing":
        (settings.staging_root / f"{STAGED_MEDIA_ID}.media").unlink()
    elif mutation == "bytes":
        request["input"] = {"stagedMediaId": STAGED_MEDIA_ID, "expectedByteCount": 1}
    elif mutation == "range":
        request["selection"] = {"kind": "frame", "frameIndex": 9999}
    else:
        request["selection"] = {"kind": "timestamp", "timestampMs": True}
        expected = "INVALID_REQUEST"
    response = TestClient(create_app(settings)).post("/v1/frames/select", json=request)
    assert response.status_code == 422
    assert response.json() == {
        "contractVersion": "source-frame.v1",
        "error": {"code": expected, "message": "source frame selection rejected"},
    }


@pytest.mark.parametrize("executable", ["/bin/true", "/bin/false", "/missing/ffmpeg"])
def test_decoder_failure_is_safe(
    settings: ServiceSettings, accepted_video: Path, executable: str
) -> None:
    request = frame_request(settings, accepted_video)
    configured = replace(settings, ffmpeg_executable=Path(executable))
    response = TestClient(create_app(configured)).post(
        "/v1/frames/select", json=request
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "FRAME_UNAVAILABLE"


@pytest.mark.parametrize(
    ("fixture", "code", "status"),
    [
        ("slow-decoder.py", "PROCESS_TIMEOUT", 503),
        ("oversized-decoder.py", "RESOURCE_LIMIT", 422),
    ],
)
def test_decoder_resource_limits(
    settings: ServiceSettings,
    accepted_video: Path,
    fixture: str,
    code: str,
    status: int,
) -> None:
    executable = Path(__file__).parent / "fixtures" / "source-frame" / fixture
    executable.chmod(0o755)
    configured = replace(
        settings,
        ffmpeg_executable=executable,
        limits=replace(settings.limits, process_timeout_seconds=2),
    )
    response = TestClient(create_app(configured)).post(
        "/v1/frames/select", json=frame_request(settings, accepted_video)
    )
    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert list(settings.work_root.iterdir()) == []


def test_concurrent_selection_obeys_shared_admission(
    settings: ServiceSettings, accepted_video: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entered = threading.Event()
    release = threading.Event()
    original = subprocess.Popen

    def controlled_process(*args: object, **kwargs: object) -> subprocess.Popen[bytes]:
        entered.set()
        assert release.wait(10)
        return original(*args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", controlled_process)
    request = frame_request(settings, accepted_video)
    client = TestClient(create_app(settings))
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, "/v1/frames/select", json=request)
        assert entered.wait(10)
        try:
            response = client.post("/v1/frames/select", json=request)
            assert response.status_code == 503
            assert response.json()["error"]["code"] == "SERVICE_BUSY"
        finally:
            release.set()
        assert first.result().status_code == 200


def test_oversized_selection_body_has_versioned_error(
    settings: ServiceSettings,
) -> None:
    response = TestClient(create_app(settings)).post(
        "/v1/frames/select", content=b" " * (settings.limits.max_request_body_bytes + 1)
    )
    assert response.status_code == 413
    assert response.json()["contractVersion"] == "source-frame.v1"
