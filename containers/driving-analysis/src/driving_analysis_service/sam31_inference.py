import hashlib
import math
import threading
from collections.abc import Callable, Generator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Self

from pydantic import ValidationError

from driving_analysis_service.contracts import (
    NormalizedBox,
    SubjectProvenance,
    SubjectSeed,
)
from driving_analysis_service.inference import (
    InferenceFailureError,
    InferenceFrame,
    InferenceUnavailableError,
    configuration_provenance,
)
from driving_analysis_service.settings import InferenceSettings
from driving_analysis_service.tracking_contracts import ProviderCandidate

MIN_AREA_RATIO = 0.05
MAX_SEED_AREA_RATIO = 25.0
MAX_FRAME_AREA_RATIO = 8.0
MAX_CENTER_DISPLACEMENT = 0.35
CHECKSUM_CHUNK_BYTES = 1024 * 1024


@dataclass(frozen=True)
class Sam31FrameResult:
    box: tuple[float, float, float, float] | None
    score: float


class Sam31Runtime(Protocol):
    def ready(self) -> bool: ...

    def track(
        self,
        *,
        frame_directory: Path,
        seed_position: int,
        seed_box: tuple[float, float, float, float],
        frame_count: int,
        timeout_seconds: float | None = None,
    ) -> Generator[Sam31FrameResult]: ...


type Sam31RuntimeFactory = Callable[[Path], Sam31Runtime]


class Sam31InferenceProvider:
    def __init__(
        self,
        settings: InferenceSettings,
        runtime_factory: Sam31RuntimeFactory,
    ) -> None:
        self.settings = settings
        self._provenance = configuration_provenance(settings)
        self._runtime_factory = runtime_factory
        self._runtime: Sam31Runtime | None = None
        self._runtime_lock = threading.Lock()

    @classmethod
    def create(
        cls,
        settings: InferenceSettings,
        *,
        runtime_factory: Sam31RuntimeFactory | None = None,
    ) -> Self:
        return cls(settings, runtime_factory or _create_cuda_runtime)

    @property
    def provenance(self) -> SubjectProvenance:
        return self._provenance

    def ready(self, *, timeout_seconds: float | None = None) -> bool:
        del timeout_seconds
        with self._runtime_lock:
            if self._runtime is not None:
                return self._runtime.ready()
            checkpoint = self.settings.checkpoint_path
            if checkpoint is None or not _checkpoint_matches(
                checkpoint,
                self.settings.model_digest,
            ):
                return False
            try:
                runtime = self._runtime_factory(checkpoint)
            except Exception:  # noqa: BLE001 - external CUDA/model boundary
                return False
            if not runtime.ready():
                return False
            self._runtime = runtime
            return True

    def track_segment(
        self,
        *,
        seed_frame: InferenceFrame,
        frames: tuple[InferenceFrame, ...],
        seed: SubjectSeed,
        timeout_seconds: float | None = None,
    ) -> Generator[ProviderCandidate]:
        if not self.ready(timeout_seconds=timeout_seconds):
            raise InferenceUnavailableError
        runtime = self._runtime
        if runtime is None:
            raise InferenceUnavailableError
        frame_directory, seed_position = _segment_location(seed_frame, frames)
        seed_box = _box_tuple(seed.box)
        previous_box: NormalizedBox | None = None
        stream = runtime.track(
            frame_directory=frame_directory,
            seed_position=seed_position,
            seed_box=seed_box,
            frame_count=len(frames),
            timeout_seconds=timeout_seconds,
        )
        try:
            for result in stream:
                candidate = _candidate(result, seed.box, previous_box)
                if candidate.visibility == "visible":
                    previous_box = candidate.box
                yield candidate
        finally:
            stream.close()


def _create_cuda_runtime(checkpoint: Path) -> Sam31Runtime:
    from driving_analysis_service.sam31_runtime import (  # noqa: PLC0415
        Sam31CudaRuntime,
    )

    return Sam31CudaRuntime(checkpoint)


def _checkpoint_matches(path: Path, expected_digest: str) -> bool:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as checkpoint:
            while chunk := checkpoint.read(CHECKSUM_CHUNK_BYTES):
                digest.update(chunk)
    except OSError:
        return False
    return digest.hexdigest() == expected_digest


def _segment_location(
    seed_frame: InferenceFrame,
    frames: tuple[InferenceFrame, ...],
) -> tuple[Path, int]:
    if not frames or frames[0] != seed_frame:
        raise InferenceFailureError
    frame_directory = seed_frame.image_path.parent
    try:
        positions = tuple(int(frame.image_path.stem) for frame in frames)
    except ValueError as error:
        raise InferenceFailureError from error
    if any(frame.image_path.parent != frame_directory for frame in frames):
        raise InferenceFailureError
    expected = tuple(range(positions[0], positions[0] + len(positions)))
    if positions != expected:
        raise InferenceFailureError
    return frame_directory, positions[0]


def _candidate(
    result: Sam31FrameResult,
    seed_box: NormalizedBox,
    previous_box: NormalizedBox | None,
) -> ProviderCandidate:
    if not math.isfinite(result.score) or not 0.0 <= result.score <= 1.0:
        raise InferenceFailureError
    if result.box is None:
        return ProviderCandidate(
            box=None,
            identityConfidence=result.score,
            visibility="uncertain",
        )
    try:
        box = NormalizedBox(
            x=result.box[0],
            y=result.box[1],
            width=result.box[2],
            height=result.box[3],
        )
    except ValidationError as error:
        raise InferenceFailureError from error
    trusted = _geometry_is_plausible(box, seed_box, previous_box)
    return ProviderCandidate(
        box=box,
        identityConfidence=result.score,
        visibility="visible" if trusted else "uncertain",
    )


def _geometry_is_plausible(
    box: NormalizedBox,
    seed_box: NormalizedBox,
    previous_box: NormalizedBox | None,
) -> bool:
    reference = previous_box or seed_box
    area_ratio = _area(box) / _area(reference)
    maximum_ratio = (
        MAX_FRAME_AREA_RATIO if previous_box is not None else MAX_SEED_AREA_RATIO
    )
    if not MIN_AREA_RATIO <= area_ratio <= maximum_ratio:
        return False
    center_distance = math.dist(_center(box), _center(reference))
    return center_distance <= MAX_CENTER_DISPLACEMENT


def _area(box: NormalizedBox) -> float:
    return box.width * box.height


def _center(box: NormalizedBox) -> tuple[float, float]:
    return (box.x + box.width / 2, box.y + box.height / 2)


def _box_tuple(box: NormalizedBox) -> tuple[float, float, float, float]:
    return (box.x, box.y, box.width, box.height)
