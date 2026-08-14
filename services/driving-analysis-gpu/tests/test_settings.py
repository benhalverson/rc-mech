from pathlib import Path

import pytest

from chassis_notes_gpu_worker.profile import InferenceProfile
from chassis_notes_gpu_worker.settings import WorkerSettings


def test_settings_load_profile_and_positive_limits(
    tmp_path: Path,
    profile: InferenceProfile,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(profile.model_dump_json(by_alias=True))
    monkeypatch.setenv("GPU_INFERENCE_PROFILE_PATH", str(profile_path))
    monkeypatch.setenv("SAM31_CHECKPOINT_PATH", str(tmp_path / "model.pt"))
    monkeypatch.setenv("GPU_WORKER_STATE_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("GPU_WATCHDOG_SECONDS", "2")
    monkeypatch.setenv("GPU_TRANSFER_TIMEOUT_SECONDS", "3")
    monkeypatch.setenv("GPU_MAX_INPUT_BYTES", "4")
    monkeypatch.setenv("GPU_MAX_OUTPUT_BYTES", "5")
    monkeypatch.setenv("GPU_RETENTION_SECONDS", "6")

    settings = WorkerSettings.from_environment()
    settings.prepare_root()

    assert settings.installed_profile == profile
    assert settings.watchdog_seconds == 2
    assert settings.transfer_timeout_seconds == 3
    assert settings.max_input_bytes == 4
    assert settings.max_output_bytes == 5
    assert settings.retention_seconds == 6
    assert settings.state_root.is_dir()


@pytest.mark.parametrize(
    "missing",
    ["GPU_INFERENCE_PROFILE_PATH", "SAM31_CHECKPOINT_PATH"],
)
def test_settings_require_profile_and_checkpoint(
    missing: str,
    tmp_path: Path,
    profile: InferenceProfile,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(profile.model_dump_json(by_alias=True))
    values = {
        "GPU_INFERENCE_PROFILE_PATH": str(profile_path),
        "SAM31_CHECKPOINT_PATH": str(tmp_path / "model.pt"),
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv(missing)

    with pytest.raises(ValueError, match=f"{missing} is required"):
        WorkerSettings.from_environment()


@pytest.mark.parametrize("profile_value", [b"invalid", b"{}"])
def test_settings_reject_invalid_profile(
    profile_value: bytes,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_path = tmp_path / "profile.json"
    profile_path.write_bytes(profile_value)
    monkeypatch.setenv("GPU_INFERENCE_PROFILE_PATH", str(profile_path))
    monkeypatch.setenv("SAM31_CHECKPOINT_PATH", str(tmp_path / "model.pt"))

    with pytest.raises(ValueError, match="Installed inference profile is invalid"):
        WorkerSettings.from_environment()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("GPU_WATCHDOG_SECONDS", "0"),
        ("GPU_TRANSFER_TIMEOUT_SECONDS", "-1"),
        ("GPU_MAX_INPUT_BYTES", "0"),
        ("GPU_MAX_OUTPUT_BYTES", "-1"),
        ("GPU_RETENTION_SECONDS", "0"),
    ],
)
def test_settings_require_positive_limits(
    name: str,
    value: str,
    tmp_path: Path,
    profile: InferenceProfile,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(profile.model_dump_json(by_alias=True))
    monkeypatch.setenv("GPU_INFERENCE_PROFILE_PATH", str(profile_path))
    monkeypatch.setenv("SAM31_CHECKPOINT_PATH", str(tmp_path / "model.pt"))
    monkeypatch.setenv(name, value)

    with pytest.raises(ValueError, match="GPU worker limits must be positive"):
        WorkerSettings.from_environment()
