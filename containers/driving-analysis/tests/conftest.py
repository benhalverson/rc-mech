import shutil
import subprocess
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

import pytest

from driving_analysis_service.settings import MediaLimits, ServiceSettings

CORRELATION_ID = "c3d1ea64-7c62-4a1e-a41f-43fe101b7f41"
STAGED_MEDIA_ID = "09e32fc7-6bdd-4bc2-852c-fc29329e58d6"

VideoFactory = Callable[[str, int, int, float, str], Path]


@pytest.fixture
def settings(tmp_path: Path) -> ServiceSettings:
    return ServiceSettings(
        staging_root=tmp_path / "staged",
        work_root=tmp_path / "work",
        limits=MediaLimits(
            max_bytes=2 * 1024 * 1024,
            max_duration_ms=2_000,
            max_width=320,
            max_height=180,
            max_frames=100,
            process_timeout_seconds=10,
            max_process_output_bytes=128 * 1024,
        ),
    )


@pytest.fixture
def video_factory(tmp_path: Path) -> VideoFactory:
    def create_video(
        name: str,
        width: int = 160,
        height: int = 90,
        duration_seconds: float = 0.5,
        codec: str = "libx264",
    ) -> Path:
        output = tmp_path / name
        subprocess.run(  # noqa: S603 - fixed test-only FFmpeg command
            (
                "/usr/bin/ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                f"color=c=blue:s={width}x{height}:r=10:d={duration_seconds}",
                "-c:v",
                codec,
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                "-y",
                str(output),
            ),
            check=True,
            capture_output=True,
        )
        return output

    return create_video


@pytest.fixture
def accepted_video(video_factory: VideoFactory) -> Path:
    return video_factory("accepted.mp4", 160, 90, 0.5, "libx264")


def stage_media(
    settings: ServiceSettings,
    source: Path,
    *,
    staged_media_id: str = STAGED_MEDIA_ID,
) -> int:
    settings.prepare_roots()
    staged_path = settings.staging_root / f"{staged_media_id}.media"
    shutil.copyfile(source, staged_path)
    return staged_path.stat().st_size


def request_body(
    byte_count: int,
    *,
    correlation_id: object = CORRELATION_ID,
    staged_media_id: object = STAGED_MEDIA_ID,
) -> dict[str, object]:
    return {
        "contractVersion": "race-video-validation.v1",
        "correlationId": correlation_id,
        "input": {
            "stagedMediaId": staged_media_id,
            "expectedByteCount": byte_count,
        },
    }


@pytest.fixture
def settings_with_limits() -> Callable[[ServiceSettings, MediaLimits], ServiceSettings]:
    def update(
        original: ServiceSettings,
        limits: MediaLimits,
    ) -> ServiceSettings:
        return replace(original, limits=limits)

    return update


@pytest.fixture(autouse=True)
def no_leftover_default_roots(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RC_MECH_MEDIA_STAGING_ROOT", raising=False)
    monkeypatch.delenv("RC_MECH_MEDIA_WORK_ROOT", raising=False)
