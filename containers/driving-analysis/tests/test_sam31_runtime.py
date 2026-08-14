from collections.abc import Callable, Generator
from pathlib import Path
from types import SimpleNamespace

import pytest

import driving_analysis_service.sam31_runtime as runtime_module
from driving_analysis_service.inference import InferenceFailureError
from driving_analysis_service.sam31_runtime import Sam31CudaRuntime

_DEFAULT_SESSION = object()


class _Array:
    def __init__(self, value: object) -> None:
        self.value = value

    def tolist(self) -> object:
        return self.value


class _Predictor:
    def __init__(
        self,
        responses: tuple[object, ...],
        *,
        session_response: object = _DEFAULT_SESSION,
    ) -> None:
        self.responses = responses
        self.session_response = (
            {"session_id": "session-1"}
            if session_response is _DEFAULT_SESSION
            else session_response
        )
        self.requests: list[dict[str, object]] = []
        self.stream_closed = False

    def handle_request(self, request: dict[str, object]) -> object:
        self.requests.append(request)
        if request["type"] == "start_session":
            return self.session_response
        return {"is_success": True}

    def handle_stream_request(
        self,
        request: dict[str, object],
    ) -> Generator[object]:
        self.requests.append(request)
        try:
            yield from self.responses
        finally:
            self.stream_closed = True


def _factory(predictor: _Predictor) -> Callable[[Path], _Predictor]:
    return lambda _checkpoint: predictor


def _output(
    frame_index: int,
    *,
    ids: object,
    boxes: object,
    scores: object,
) -> dict[str, object]:
    return {
        "frame_index": frame_index,
        "outputs": {
            "out_obj_ids": ids,
            "out_boxes_xywh": boxes,
            "out_probs": scores,
        },
    }


def test_sam31_runtime_uses_official_point_prompt_video_api(tmp_path: Path) -> None:
    predictor = _Predictor(
        (
            _output(
                2,
                ids=_Array([1]),
                boxes=_Array([[0.1, 0.2, 0.3, 0.4]]),
                scores=_Array([0.94]),
            ),
            _output(3, ids=[], boxes=[], scores=[]),
        )
    )
    runtime = Sam31CudaRuntime(
        tmp_path / "checkpoint.pt",
        predictor_factory=_factory(predictor),
    )

    results = list(
        runtime.track(
            frame_directory=tmp_path / "frames",
            seed_position=2,
            seed_box=(0.1, 0.2, 0.2, 0.2),
            frame_count=2,
            timeout_seconds=1.0,
        )
    )

    assert runtime.ready()
    assert results[0].box == (0.1, 0.2, 0.3, 0.4)
    assert results[0].score == 0.94
    assert results[1].box is None
    assert results[1].score == 0.0
    assert predictor.requests == [
        {
            "type": "start_session",
            "resource_path": str(tmp_path / "frames"),
            "offload_video_to_cpu": True,
        },
        {
            "type": "add_prompt",
            "session_id": "session-1",
            "frame_index": 2,
            "points": [[0.2, 0.30000000000000004]],
            "point_labels": [1],
            "obj_id": 1,
        },
        {
            "type": "propagate_in_video",
            "session_id": "session-1",
            "propagation_direction": "forward",
            "start_frame_index": 2,
            "max_frame_num_to_track": 1,
        },
        {"type": "close_session", "session_id": "session-1"},
    ]
    assert predictor.stream_closed


@pytest.mark.parametrize(
    "response",
    [
        _output(0, ids=[1, 1], boxes=[[0.1] * 4, [0.2] * 4], scores=[1.0, 1.0]),
        _output(0, ids=[1], boxes=[], scores=[1.0]),
        _output(0, ids=[1], boxes=[[0.1] * 3], scores=[1.0]),
        _output(0, ids=[1], boxes=[[0.1] * 4], scores=[float("nan")]),
    ],
)
def test_sam31_runtime_rejects_malformed_model_output(
    tmp_path: Path,
    response: object,
) -> None:
    predictor = _Predictor((response,))
    runtime = Sam31CudaRuntime(
        tmp_path / "checkpoint.pt",
        predictor_factory=lambda _checkpoint: predictor,
    )

    with pytest.raises(InferenceFailureError):
        list(
            runtime.track(
                frame_directory=tmp_path,
                seed_position=0,
                seed_box=(0.1, 0.2, 0.2, 0.2),
                frame_count=1,
            )
        )

    assert predictor.stream_closed
    assert predictor.requests[-1] == {
        "type": "close_session",
        "session_id": "session-1",
    }


def test_sam31_runtime_rejects_missing_or_out_of_order_frames(
    tmp_path: Path,
) -> None:
    for responses in (
        (),
        (_output(1, ids=[], boxes=[], scores=[]),),
        (
            _output(0, ids=[], boxes=[], scores=[]),
            _output(1, ids=[], boxes=[], scores=[]),
        ),
    ):
        predictor = _Predictor(responses)

        runtime = Sam31CudaRuntime(
            tmp_path / "checkpoint.pt",
            predictor_factory=_factory(predictor),
        )
        with pytest.raises(InferenceFailureError):
            list(
                runtime.track(
                    frame_directory=tmp_path,
                    seed_position=0,
                    seed_box=(0.1, 0.2, 0.2, 0.2),
                    frame_count=1,
                )
            )


def test_sam31_runtime_rejects_invalid_session_and_expired_deadline(
    tmp_path: Path,
) -> None:
    for response in (None, {1: "invalid"}, {"session_id": ""}):
        predictor = _Predictor((), session_response=response)
        runtime = Sam31CudaRuntime(
            tmp_path / "checkpoint.pt",
            predictor_factory=_factory(predictor),
        )
        with pytest.raises(InferenceFailureError):
            list(
                runtime.track(
                    frame_directory=tmp_path,
                    seed_position=0,
                    seed_box=(0.1, 0.2, 0.2, 0.2),
                    frame_count=1,
                )
            )

    predictor = _Predictor(())
    runtime = Sam31CudaRuntime(
        tmp_path / "checkpoint.pt",
        predictor_factory=_factory(predictor),
    )
    with pytest.raises(InferenceFailureError):
        next(
            runtime.track(
                frame_directory=tmp_path,
                seed_position=0,
                seed_box=(0.1, 0.2, 0.2, 0.2),
                frame_count=1,
                timeout_seconds=0.0,
            )
        )


def test_sam31_runtime_rejects_invalid_envelopes_and_values(
    tmp_path: Path,
) -> None:
    responses = (
        "not-an-envelope",
        {"frame_index": 0, "outputs": "not-outputs"},
        _output(0, ids=[True], boxes=[[0.1] * 4], scores=[1.0]),
        _output(0, ids=[1], boxes=[[True, 0.1, 0.1, 0.1]], scores=[1.0]),
    )
    for response in responses:
        predictor = _Predictor((response,))
        runtime = Sam31CudaRuntime(
            tmp_path / "checkpoint.pt",
            predictor_factory=_factory(predictor),
        )
        with pytest.raises(InferenceFailureError):
            list(
                runtime.track(
                    frame_directory=tmp_path,
                    seed_position=0,
                    seed_box=(0.1, 0.2, 0.2, 0.2),
                    frame_count=1,
                )
            )


def test_sam31_runtime_helpers_validate_external_values() -> None:
    assert runtime_module._list((1, 2)) == [1, 2]
    with pytest.raises(InferenceFailureError):
        runtime_module._list(_Array("not-a-list"))
    with pytest.raises(InferenceFailureError):
        runtime_module._list("not-a-list")
    with pytest.raises(InferenceFailureError):
        runtime_module._integer(1.0)
    with pytest.raises(InferenceFailureError):
        runtime_module._number(float("nan"))
    with pytest.raises(InferenceFailureError):
        runtime_module._number("not-a-number")
    with pytest.raises(InferenceFailureError):
        runtime_module._string(None)


def test_sam31_runtime_builds_the_pinned_cuda_predictor(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    predictor = _Predictor(())
    calls: list[dict[str, object]] = []

    def builder(**kwargs: object) -> _Predictor:
        calls.append(kwargs)
        return predictor

    cuda = SimpleNamespace(is_available=lambda: True)
    modules = {
        "torch": SimpleNamespace(cuda=cuda),
        "sam3.model_builder": SimpleNamespace(
            build_sam3_multiplex_video_predictor=builder
        ),
    }
    monkeypatch.setattr(
        "driving_analysis_service.sam31_runtime.importlib.import_module",
        lambda name: modules[name],
    )
    checkpoint = tmp_path / "sam3.1.pt"

    assert runtime_module._build_predictor(checkpoint) is predictor
    assert calls == [
        {
            "checkpoint_path": str(checkpoint),
            "max_num_objects": 1,
            "use_fa3": False,
            "use_rope_real": False,
            "compile": False,
            "warm_up": False,
            "async_loading_frames": False,
        }
    ]

    modules["torch"] = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))
    with pytest.raises(RuntimeError):
        runtime_module._build_predictor(checkpoint)

    modules["torch"] = SimpleNamespace(cuda=cuda)
    modules["sam3.model_builder"] = SimpleNamespace()
    with pytest.raises(TypeError):
        runtime_module._build_predictor(checkpoint)
