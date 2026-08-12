import os
from dataclasses import dataclass, field
from pathlib import Path

FFPROBE_EXECUTABLE = Path("/usr/bin/ffprobe")
FFMPEG_EXECUTABLE = Path("/usr/bin/ffmpeg")


@dataclass(frozen=True)
class MediaLimits:
    max_bytes: int = 50 * 1024 * 1024 * 1024
    max_duration_ms: int = 4 * 60 * 60 * 1000
    max_width: int = 3840
    max_height: int = 2160
    max_frames: int = 1_000_000
    process_timeout_seconds: float = 15 * 60
    max_process_output_bytes: int = 1024 * 1024
    supported_video_codecs: frozenset[str] = field(
        default_factory=lambda: frozenset(
            {"av1", "h264", "hevc", "mpeg4", "vp8", "vp9"}
        )
    )


@dataclass(frozen=True)
class ServiceSettings:
    staging_root: Path
    work_root: Path
    ffprobe_executable: Path = FFPROBE_EXECUTABLE
    ffmpeg_executable: Path = FFMPEG_EXECUTABLE
    limits: MediaLimits = field(default_factory=MediaLimits)

    @classmethod
    def from_environment(cls) -> "ServiceSettings":
        return cls(
            staging_root=Path(
                os.environ.get("RC_MECH_MEDIA_STAGING_ROOT", "/var/lib/rc-mech/staged")
            ),
            work_root=Path(
                os.environ.get(
                    "RC_MECH_MEDIA_WORK_ROOT",
                    "/tmp/rc-mech-media",  # noqa: S108 - private container scratch root
                )
            ),
        )

    def prepare_roots(self) -> None:
        self.staging_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.work_root.mkdir(mode=0o700, parents=True, exist_ok=True)
