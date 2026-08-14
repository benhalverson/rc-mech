import os
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from chassis_notes_gpu_worker.profile import InferenceProfile


@dataclass(frozen=True)
class WorkerSettings:
    state_root: Path
    checkpoint_path: Path
    installed_profile: InferenceProfile
    watchdog_seconds: float = 120.0
    transfer_timeout_seconds: float = 30 * 60
    max_input_bytes: int = 50 * 1024 * 1024 * 1024
    max_output_bytes: int = 64 * 1024 * 1024

    @classmethod
    def from_environment(cls) -> "WorkerSettings":
        profile_path = Path(_required("GPU_INFERENCE_PROFILE_PATH"))
        try:
            installed_profile = InferenceProfile.model_validate_json(
                profile_path.read_bytes()
            )
        except (OSError, ValidationError) as error:
            message = "Installed inference profile is invalid"
            raise ValueError(message) from error
        watchdog_seconds = float(os.environ.get("GPU_WATCHDOG_SECONDS", "120"))
        transfer_timeout_seconds = float(
            os.environ.get("GPU_TRANSFER_TIMEOUT_SECONDS", "1800")
        )
        max_input_bytes = int(
            os.environ.get("GPU_MAX_INPUT_BYTES", str(50 * 1024 * 1024 * 1024))
        )
        max_output_bytes = int(
            os.environ.get("GPU_MAX_OUTPUT_BYTES", str(64 * 1024 * 1024))
        )
        if (
            watchdog_seconds <= 0
            or transfer_timeout_seconds <= 0
            or max_input_bytes <= 0
            or max_output_bytes <= 0
        ):
            message = "GPU worker limits must be positive"
            raise ValueError(message)
        return cls(
            state_root=Path(
                os.environ.get("GPU_WORKER_STATE_ROOT", "/var/lib/chassis-notes-gpu")
            ),
            checkpoint_path=Path(_required("SAM31_CHECKPOINT_PATH")),
            installed_profile=installed_profile,
            watchdog_seconds=watchdog_seconds,
            transfer_timeout_seconds=transfer_timeout_seconds,
            max_input_bytes=max_input_bytes,
            max_output_bytes=max_output_bytes,
        )

    def prepare_root(self) -> None:
        self.state_root.mkdir(mode=0o700, parents=True, exist_ok=True)


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        message = f"{name} is required"
        raise ValueError(message)
    return value
