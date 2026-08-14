import importlib
import math
import threading
import time
from collections.abc import Callable, Generator, Mapping
from pathlib import Path
from typing import Protocol, cast, runtime_checkable

from driving_analysis_service.inference import InferenceFailureError
from driving_analysis_service.sam31_inference import Sam31FrameResult

SUBJECT_OBJECT_ID = 1
BOX_VALUE_COUNT = 4


class _Predictor(Protocol):
    def handle_request(self, request: dict[str, object]) -> object: ...

    def handle_stream_request(
        self,
        request: dict[str, object],
    ) -> Generator[object]: ...


type _PredictorFactory = Callable[[Path], _Predictor]


@runtime_checkable
class _SupportsToList(Protocol):
    def tolist(self) -> object: ...


class _Cuda(Protocol):
    def is_available(self) -> bool: ...


class _Torch(Protocol):
    cuda: _Cuda


class Sam31CudaRuntime:
    def __init__(
        self,
        checkpoint: Path,
        *,
        predictor_factory: _PredictorFactory | None = None,
    ) -> None:
        self._predictor = (predictor_factory or _build_predictor)(checkpoint)
        self._lock = threading.Lock()

    def ready(self) -> bool:
        return True

    def track(
        self,
        *,
        frame_directory: Path,
        seed_position: int,
        seed_box: tuple[float, float, float, float],
        frame_count: int,
        timeout_seconds: float | None = None,
    ) -> Generator[Sam31FrameResult]:
        deadline = (
            None if timeout_seconds is None else time.monotonic() + timeout_seconds
        )
        with self._lock:
            _check_deadline(deadline)
            session = _mapping(
                self._predictor.handle_request(
                    {
                        "type": "start_session",
                        "resource_path": str(frame_directory),
                        "offload_video_to_cpu": True,
                    }
                )
            )
            session_id = _string(session.get("session_id"))
            try:
                center_x = seed_box[0] + seed_box[2] / 2
                center_y = seed_box[1] + seed_box[3] / 2
                _check_deadline(deadline)
                self._predictor.handle_request(
                    {
                        "type": "add_prompt",
                        "session_id": session_id,
                        "frame_index": seed_position,
                        "points": [[center_x, center_y]],
                        "point_labels": [1],
                        "obj_id": SUBJECT_OBJECT_ID,
                    }
                )
                stream = self._predictor.handle_stream_request(
                    {
                        "type": "propagate_in_video",
                        "session_id": session_id,
                        "propagation_direction": "forward",
                        "start_frame_index": seed_position,
                        "max_frame_num_to_track": frame_count - 1,
                    }
                )
                yielded = 0
                try:
                    for response in stream:
                        _check_deadline(deadline)
                        envelope = _mapping(response)
                        frame_index = _integer(envelope.get("frame_index"))
                        if frame_index != seed_position + yielded:
                            raise InferenceFailureError
                        if yielded >= frame_count:
                            raise InferenceFailureError
                        outputs = _mapping(envelope.get("outputs"))
                        yield _frame_result(outputs)
                        yielded += 1
                    if yielded != frame_count:
                        raise InferenceFailureError
                finally:
                    stream.close()
            finally:
                self._predictor.handle_request(
                    {
                        "type": "close_session",
                        "session_id": session_id,
                    }
                )


def _build_predictor(checkpoint: Path) -> _Predictor:
    torch = cast("_Torch", importlib.import_module("torch"))
    if not torch.cuda.is_available():
        raise RuntimeError
    builder_module = importlib.import_module("sam3.model_builder")
    builder = getattr(builder_module, "build_sam3_multiplex_video_predictor", None)
    if not callable(builder):
        raise TypeError
    predictor = builder(
        checkpoint_path=str(checkpoint),
        max_num_objects=1,
        use_fa3=False,
        use_rope_real=False,
        compile=False,
        warm_up=False,
        async_loading_frames=False,
    )
    return cast("_Predictor", predictor)


def _frame_result(outputs: Mapping[str, object]) -> Sam31FrameResult:
    object_ids = _list(outputs.get("out_obj_ids"))
    boxes = _list(outputs.get("out_boxes_xywh"))
    scores = _list(outputs.get("out_probs"))
    if len(object_ids) != len(boxes) or len(object_ids) != len(scores):
        raise InferenceFailureError
    matches = [
        index
        for index, object_id in enumerate(object_ids)
        if _integer(object_id) == SUBJECT_OBJECT_ID
    ]
    if not matches:
        return Sam31FrameResult(box=None, score=0.0)
    if len(matches) != 1:
        raise InferenceFailureError
    index = matches[0]
    raw_box = _list(boxes[index])
    if len(raw_box) != BOX_VALUE_COUNT:
        raise InferenceFailureError
    box = (
        _number(raw_box[0]),
        _number(raw_box[1]),
        _number(raw_box[2]),
        _number(raw_box[3]),
    )
    score = _number(scores[index])
    return Sam31FrameResult(box=box, score=max(0.0, min(1.0, score)))


def _check_deadline(deadline: float | None) -> None:
    if deadline is not None and time.monotonic() >= deadline:
        raise InferenceFailureError


def _mapping(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise InferenceFailureError
    if not all(isinstance(key, str) for key in value):
        raise InferenceFailureError
    return cast("Mapping[str, object]", value)


def _list(value: object) -> list[object]:
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, _SupportsToList):
        converted = value.tolist()
        if isinstance(converted, list):
            return cast("list[object]", converted)
    raise InferenceFailureError


def _integer(value: object) -> int:
    if type(value) is not int:
        raise InferenceFailureError
    return value


def _number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InferenceFailureError
    number = float(value)
    if not math.isfinite(number):
        raise InferenceFailureError
    return number


def _string(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise InferenceFailureError
    return value
