import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, cast

FFPROBE_EXECUTABLE = Path("/usr/bin/ffprobe")
FFMPEG_EXECUTABLE = Path("/usr/bin/ffmpeg")
DEFAULT_MODEL_DIGEST = "0" * 64


@dataclass(frozen=True)
class InferenceSettings:
    provider: Literal["disabled", "local-http", "fixture", "fake"] = "disabled"
    model: str = "disabled"
    model_version: str = "1"
    model_digest: str = DEFAULT_MODEL_DIGEST
    confidence_calibration: str = "unavailable"
    identity_confidence_threshold: float = 1.0
    endpoint: str | None = None
    fixture_path: Path | None = None
    request_timeout_seconds: float = 30.0
    max_response_bytes: int = 64 * 1024

    @classmethod
    def from_environment(cls) -> "InferenceSettings":
        provider = os.environ.get("INFERENCE_PROVIDER", "disabled")
        if provider not in {"disabled", "local-http", "fixture", "fake"}:
            msg = "INFERENCE_PROVIDER must be disabled, local-http, fixture, or fake"
            raise ValueError(msg)
        threshold = float(
            os.environ.get("INFERENCE_IDENTITY_CONFIDENCE_THRESHOLD", "0.8")
        )
        timeout_seconds = float(
            os.environ.get("INFERENCE_REQUEST_TIMEOUT_SECONDS", "30")
        )
        if not 0.0 <= threshold <= 1.0:
            msg = "Inference identity confidence threshold must be between zero and one"
            raise ValueError(msg)
        if timeout_seconds <= 0:
            msg = "Inference request timeout must be positive"
            raise ValueError(msg)

        endpoint = os.environ.get("INFERENCE_PROVIDER_URL")
        fixture = os.environ.get("INFERENCE_FIXTURE_PATH")
        return cls(
            provider=cast(
                "Literal['disabled', 'local-http', 'fixture', 'fake']", provider
            ),
            model=os.environ.get("INFERENCE_MODEL", provider),
            model_version=os.environ.get("INFERENCE_MODEL_VERSION", "1"),
            model_digest=os.environ.get("INFERENCE_MODEL_DIGEST", DEFAULT_MODEL_DIGEST),
            confidence_calibration=os.environ.get(
                "INFERENCE_CONFIDENCE_CALIBRATION",
                f"{provider}-provider-specific-v1",
            ),
            identity_confidence_threshold=threshold,
            endpoint=endpoint,
            fixture_path=Path(fixture) if fixture is not None else None,
            request_timeout_seconds=timeout_seconds,
        )


@dataclass(frozen=True)
class MediaLimits:
    max_bytes: int = 50 * 1024 * 1024 * 1024
    max_duration_ms: int = 4 * 60 * 60 * 1000
    max_width: int = 3840
    max_height: int = 2160
    max_frames: int = 1_000_000
    process_timeout_seconds: float = 15 * 60
    max_process_output_bytes: int = 1024 * 1024
    max_request_body_bytes: int = 4 * 1024
    max_concurrent_validations: int = 2
    supported_video_codecs: frozenset[str] = field(
        default_factory=lambda: frozenset(
            {"av1", "h264", "hevc", "mpeg4", "vp8", "vp9"}
        )
    )
    supported_demuxers: tuple[str, ...] = ("matroska", "mov")
    supported_container_formats: frozenset[str] = field(
        default_factory=lambda: frozenset(
            {"3g2", "3gp", "m4a", "matroska", "mj2", "mov", "mp4", "webm"}
        )
    )


@dataclass(frozen=True)
class ServiceSettings:
    staging_root: Path
    work_root: Path
    artifact_root: Path
    ffprobe_executable: Path = FFPROBE_EXECUTABLE
    ffmpeg_executable: Path = FFMPEG_EXECUTABLE
    limits: MediaLimits = field(default_factory=MediaLimits)
    inference: InferenceSettings = field(default_factory=InferenceSettings)

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
            artifact_root=Path(
                os.environ.get(
                    "RC_MECH_ANALYSIS_ARTIFACT_ROOT",
                    "/var/lib/rc-mech/artifacts",
                )
            ),
            inference=InferenceSettings.from_environment(),
        )

    def prepare_roots(self) -> None:
        self.staging_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.work_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.artifact_root.mkdir(mode=0o700, parents=True, exist_ok=True)
