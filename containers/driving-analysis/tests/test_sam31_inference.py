import hashlib
from collections.abc import Callable, Generator
from dataclasses import replace
from pathlib import Path

import pytest

import driving_analysis_service.sam31_inference as sam31_module
import driving_analysis_service.sam31_runtime as runtime_module
from driving_analysis_service.contracts import SubjectSeed
from driving_analysis_service.inference import (
    InferenceFailureError,
    InferenceFrame,
    InferenceUnavailableError,
)
from driving_analysis_service.sam31_inference import (
    Sam31FrameResult,
    Sam31InferenceProvider,
    Sam31Runtime,
)
from driving_analysis_service.settings import InferenceSettings
from driving_analysis_service.tracking_contracts import PreparedFrame


class _Runtime:
    def __init__(
        self,
        results: tuple[Sam31FrameResult, ...],
        *,
        is_ready: bool = True,
    ) -> None:
        self.results = results
        self.is_ready = is_ready
        self.closed = False
        self.calls: list[tuple[Path, int, tuple[float, float, float, float], int]] = []

    def ready(self) -> bool:
        return self.is_ready

    def track(
        self,
        *,
        frame_directory: Path,
        seed_position: int,
        seed_box: tuple[float, float, float, float],
        frame_count: int,
        timeout_seconds: float | None = None,
    ) -> Generator[Sam31FrameResult]:
        del timeout_seconds
        self.calls.append((frame_directory, seed_position, seed_box, frame_count))
        try:
            yield from self.results
        finally:
            self.closed = True


def _settings(checkpoint: Path, digest: str) -> InferenceSettings:
    return InferenceSettings(
        provider="sam31",
        model="sam3.1",
        model_version="2026-03-27",
        model_digest=digest,
        confidence_calibration="sam31-mask-score-v1",
        identity_confidence_threshold=0.3,
        checkpoint_path=checkpoint,
    )


def _seed() -> SubjectSeed:
    return SubjectSeed.model_validate(
        {
            "timestampMs": 100,
            "frameIndex": 1,
            "identity": "subject",
            "box": {"x": 0.8, "y": 0.3, "width": 0.04, "height": 0.06},
        }
    )


def _frames(directory: Path) -> tuple[InferenceFrame, ...]:
    frames = []
    for position, frame_index in enumerate((1, 2)):
        path = directory / f"{position:08d}.jpg"
        path.write_bytes(b"frame")
        frames.append(
            InferenceFrame(
                path,
                PreparedFrame(
                    preparedFrameIndex=position,
                    frameIndex=frame_index,
                    timestampMs=(position + 1) * 100,
                ),
            )
        )
    return tuple(frames)


def test_sam31_provider_loads_once_and_streams_one_segment(tmp_path: Path) -> None:
    checkpoint = tmp_path / "sam3.1.pt"
    checkpoint.write_bytes(b"checkpoint")
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    runtime = _Runtime(
        (
            Sam31FrameResult(box=(0.8, 0.3, 0.04, 0.06), score=0.95),
            Sam31FrameResult(box=None, score=0.2),
        )
    )
    factory_calls = 0

    def runtime_factory(_checkpoint: Path) -> Sam31Runtime:
        nonlocal factory_calls
        factory_calls += 1
        return runtime

    provider = Sam31InferenceProvider.create(
        _settings(checkpoint, digest),
        runtime_factory=runtime_factory,
    )
    frame_directory = tmp_path / "frames"
    frame_directory.mkdir()
    frames = _frames(frame_directory)

    assert provider.ready()
    assert provider.ready()
    assert factory_calls == 1
    assert provider.provenance.provider == "sam31"
    assert provider.provenance.model_digest == digest

    stream = provider.track_segment(
        seed_frame=frames[0],
        frames=frames,
        seed=_seed(),
        timeout_seconds=1.0,
    )
    candidates = list(stream)

    assert candidates[0].visibility == "visible"
    assert candidates[0].box == _seed().box
    assert candidates[1].visibility == "uncertain"
    assert candidates[1].box is None
    assert runtime.calls == [(frame_directory, 0, (0.8, 0.3, 0.04, 0.06), 2)]
    assert runtime.closed


def test_sam31_provider_rejects_untrusted_geometry_and_checkpoint(
    tmp_path: Path,
) -> None:
    checkpoint = tmp_path / "sam3.1.pt"
    checkpoint.write_bytes(b"checkpoint")
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    runtime = _Runtime((Sam31FrameResult(box=(0.0, 0.0, 0.8, 0.8), score=0.99),))
    provider = Sam31InferenceProvider.create(
        _settings(checkpoint, digest),
        runtime_factory=lambda _checkpoint: runtime,
    )
    frame_directory = tmp_path / "frames"
    frame_directory.mkdir()
    frames = _frames(frame_directory)

    stream = provider.track_segment(
        seed_frame=frames[0],
        frames=frames,
        seed=_seed(),
    )
    candidate = next(stream)
    stream.close()

    assert candidate.visibility == "uncertain"
    assert candidate.box is not None
    assert runtime.closed

    invalid = Sam31InferenceProvider.create(
        _settings(checkpoint, "0" * 64),
        runtime_factory=lambda _checkpoint: runtime,
    )
    assert not invalid.ready()
    with pytest.raises(InferenceUnavailableError):
        next(
            invalid.track_segment(
                seed_frame=frames[0],
                frames=frames,
                seed=_seed(),
            )
        )


def test_sam31_provider_handles_runtime_readiness_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    checkpoint = tmp_path / "sam3.1.pt"
    checkpoint.write_bytes(b"checkpoint")
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()

    no_checkpoint = Sam31InferenceProvider.create(
        replace(_settings(checkpoint, digest), checkpoint_path=None),
        runtime_factory=lambda _checkpoint: _Runtime(()),
    )
    assert not no_checkpoint.ready()

    def failed_factory(_checkpoint: Path) -> Sam31Runtime:
        raise RuntimeError

    failed = Sam31InferenceProvider.create(
        _settings(checkpoint, digest),
        runtime_factory=failed_factory,
    )
    assert not failed.ready()

    unavailable = Sam31InferenceProvider.create(
        _settings(checkpoint, digest),
        runtime_factory=lambda _checkpoint: _Runtime((), is_ready=False),
    )
    assert not unavailable.ready()

    impossible = Sam31InferenceProvider.create(
        _settings(checkpoint, digest),
        runtime_factory=lambda _checkpoint: _Runtime(()),
    )
    monkeypatch.setattr(impossible, "ready", lambda **_kwargs: True)
    with pytest.raises(InferenceUnavailableError):
        next(
            impossible.track_segment(
                seed_frame=_frames(tmp_path)[0],
                frames=_frames(tmp_path),
                seed=_seed(),
            )
        )


def test_sam31_default_runtime_factory_uses_cuda_runtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = _Runtime(())
    checkpoints: list[Path] = []

    def create(checkpoint: Path) -> _Runtime:
        checkpoints.append(checkpoint)
        return runtime

    monkeypatch.setattr(runtime_module, "Sam31CudaRuntime", create)

    checkpoint = tmp_path / "sam3.1.pt"
    assert sam31_module._create_cuda_runtime(checkpoint) is runtime
    assert checkpoints == [checkpoint]
    assert not sam31_module._checkpoint_matches(tmp_path / "missing.pt", "0" * 64)


def test_sam31_segment_location_rejects_non_numeric_frame(tmp_path: Path) -> None:
    frame = InferenceFrame(
        tmp_path / "not-a-number.jpg",
        _frames(tmp_path)[0].provenance,
    )

    with pytest.raises(InferenceFailureError):
        sam31_module._segment_location(frame, (frame,))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda _frames, _tmp_path: (),
        lambda frames, _tmp_path: (frames[1],),
        lambda frames, tmp_path: (
            InferenceFrame(
                tmp_path / "frames" / "not-a-number.jpg",
                frames[0].provenance,
            ),
        ),
        lambda frames, tmp_path: (
            frames[0],
            InferenceFrame(
                tmp_path / "other" / "00000001.jpg",
                frames[1].provenance,
            ),
        ),
        lambda frames, tmp_path: (
            frames[0],
            InferenceFrame(
                tmp_path / "frames" / "00000003.jpg",
                frames[1].provenance,
            ),
        ),
    ],
)
def test_sam31_provider_rejects_invalid_frame_segments(
    tmp_path: Path,
    mutate: Callable[
        [tuple[InferenceFrame, ...], Path],
        tuple[InferenceFrame, ...],
    ],
) -> None:
    checkpoint = tmp_path / "sam3.1.pt"
    checkpoint.write_bytes(b"checkpoint")
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    frame_directory = tmp_path / "frames"
    frame_directory.mkdir()
    frames = _frames(frame_directory)
    provider = Sam31InferenceProvider.create(
        _settings(checkpoint, digest),
        runtime_factory=lambda _checkpoint: _Runtime(()),
    )
    changed = mutate(frames, tmp_path)

    with pytest.raises(InferenceFailureError):
        next(
            provider.track_segment(
                seed_frame=frames[0],
                frames=changed,
                seed=_seed(),
            )
        )


@pytest.mark.parametrize(
    "result",
    [
        Sam31FrameResult(box=(0.8, 0.3, 0.04, 0.06), score=float("nan")),
        Sam31FrameResult(box=(-0.1, 0.3, 0.04, 0.06), score=0.9),
    ],
)
def test_sam31_provider_rejects_invalid_candidates(
    tmp_path: Path,
    result: Sam31FrameResult,
) -> None:
    checkpoint = tmp_path / "sam3.1.pt"
    checkpoint.write_bytes(b"checkpoint")
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    frame_directory = tmp_path / "frames"
    frame_directory.mkdir()
    frames = _frames(frame_directory)
    provider = Sam31InferenceProvider.create(
        _settings(checkpoint, digest),
        runtime_factory=lambda _checkpoint: _Runtime((result,)),
    )

    with pytest.raises(InferenceFailureError):
        next(
            provider.track_segment(
                seed_frame=frames[0],
                frames=frames,
                seed=_seed(),
            )
        )


def test_sam31_geometry_guard_uses_previous_mask_and_rejects_jumps() -> None:
    seed = _seed().box
    visible = sam31_module._candidate(
        Sam31FrameResult(box=(0.8, 0.3, 0.04, 0.06), score=0.9),
        seed,
        seed,
    )
    too_small = sam31_module._candidate(
        Sam31FrameResult(box=(0.8, 0.3, 0.001, 0.001), score=0.9),
        seed,
        seed,
    )
    jumped = sam31_module._candidate(
        Sam31FrameResult(box=(0.1, 0.1, 0.04, 0.06), score=0.9),
        seed,
        seed,
    )

    assert visible.visibility == "visible"
    assert too_small.visibility == "uncertain"
    assert jumped.visibility == "uncertain"
