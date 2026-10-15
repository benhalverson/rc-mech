import importlib
import sys
from collections.abc import Generator
from contextlib import nullcontext
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest

from driving_analysis_service.inference import InferenceFailureError
from driving_analysis_service.sam31_inference import Sam31FrameResult


@pytest.fixture
def motion_module(monkeypatch: pytest.MonkeyPatch) -> Generator[ModuleType]:
    """Exercise the adapter contract without installing GPU/image dependencies."""
    for name in (
        "cv2",
        "numpy",
        "numpy.typing",
        "PIL",
        "PIL.Image",
        "torchvision",
        "torchvision.transforms",
        "torchvision.transforms.functional",
    ):
        monkeypatch.setitem(sys.modules, name, MagicMock())
    # Make parent-package attributes agree with imports of their child modules.
    sys.modules["numpy"].typing = sys.modules["numpy.typing"]
    sys.modules["PIL"].Image = sys.modules["PIL.Image"]
    sys.modules["torchvision"].transforms = sys.modules["torchvision.transforms"]
    sys.modules["torchvision.transforms"].functional = sys.modules[
        "torchvision.transforms.functional"
    ]
    names = (
        "driving_analysis_service.motion_proposals",
        "driving_analysis_service.sam31_person_exclusion",
        "driving_analysis_service.sam31_motion_runtime",
    )
    previous = {name: sys.modules.get(name) for name in names}
    for name in names:
        monkeypatch.delitem(sys.modules, name, raising=False)
    module = importlib.import_module(names[-1])
    monkeypatch.setattr(module, "_cuda_autocast", nullcontext)
    monkeypatch.setattr(module, "_appearance", Mock(return_value=MagicMock()))
    module.np.linalg.norm.return_value = 1.0
    try:
        yield module
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


class _Predictor:
    def __init__(self) -> None:
        self.requests: list[dict[str, object]] = []
        self.states: list[dict[str, object]] = []
        self.prompts: list[tuple[dict[str, object], object]] = []
        self._all_inference_states = {"subject": {"state": {}}}
        self.box = [118 / 256, 70 / 160, 20 / 256, 20 / 160]
        self.presence = 0.9
        self.missing = False
        self.failure: Exception | None = None

    def handle_request(self, request: dict[str, object]) -> dict[str, object]:
        self.requests.append(request)
        match request["type"]:
            case "start_session":
                return {"session_id": "subject"}
            case "reset_session":
                logits = MagicMock()
                current_logit = logits.flatten.return_value.__getitem__.return_value
                current_logit.sigmoid.return_value = self.presence
                state = {
                    "input_batch": SimpleNamespace(
                        img_batch=SimpleNamespace(tensors=None)
                    ),
                    "sam2_inference_states": [
                        {
                            "output_dict": {
                                "cond_frame_outputs": {
                                    0: {"object_score_logits": logits}
                                }
                            }
                        }
                    ],
                }
                self.states.append(state)
                self._all_inference_states["subject"]["state"] = state
            case "add_prompt":
                if self.failure:
                    raise self.failure
                state = self._all_inference_states["subject"]["state"]
                self.prompts.append((request, state["input_batch"].img_batch.tensors))
                return {
                    "outputs": {
                        "out_obj_ids": [] if self.missing else [1],
                        "out_boxes_xywh": [] if self.missing else [self.box],
                        # This cached score must not override current presence.
                        "out_probs": [] if self.missing else [0.99],
                    }
                }
        return {}


def _runtime(
    module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    predictor: _Predictor,
    *,
    recover_gaps: bool = False,
) -> object:
    monkeypatch.setattr(module, "_build_predictor", Mock(return_value=predictor))
    return module.Sam31MotionRuntime(
        Path("unused.pt"), recover_gaps=recover_gaps, threshold=0.3
    )


def _track(
    module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    predictor: _Predictor,
    proposals: list[object],
    **options: object,
) -> tuple[Generator[Sam31FrameResult], Mock]:
    for index in range(len(proposals)):
        (tmp_path / f"{index}.jpg").touch()
    motion = Mock(width=1000, height=500)
    motion.read.return_value = MagicMock()
    monkeypatch.setattr(module, "FixedCameraMotion", Mock(return_value=motion))
    runtime = _runtime(module, monkeypatch, predictor)
    monkeypatch.setattr(runtime, "_proposal", Mock(side_effect=proposals))
    return runtime.track(
        frame_directory=tmp_path,
        seed_position=0,
        seed_box=(0.39, 0.42, 0.02, 0.04),
        frame_count=len(proposals),
        **options,
    ), motion


def test_each_frame_replaces_reset_state_pixels_and_translates_crop_coordinates(
    motion_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    module = motion_module
    predictor = _Predictor()
    tensors = [MagicMock(), MagicMock()]
    module.transforms.to_tensor.side_effect = tensors
    proposals = [module.MotionProposal((390, 210, 20, 20), 0.8)] * 2
    stream, motion = _track(module, monkeypatch, tmp_path, predictor, proposals)

    results = list(stream)

    assert [result.box for result in results] == [(0.39, 0.42, 0.02, 0.04)] * 2
    assert [result.score for result in results] == [0.8, 0.8]
    assert [request["type"] for request in predictor.requests] == [
        "start_session",
        "reset_session",
        "add_prompt",
        "reset_session",
        "add_prompt",
        "close_session",
    ]
    assert predictor.states[0] is not predictor.states[1]
    for index, (prompt, pixels) in enumerate(predictor.prompts):
        assert prompt["points"] == [[118 / 256, 70 / 160], [138 / 256, 90 / 160]]
        assert prompt["point_labels"] == [2, 3]
        assert prompt["frame_index"] == 0
        assert pixels is ((tensors[index].half() - 0.5) / 0.5).unsqueeze(0)
        assert predictor.states[index]["orig_width"] == 256
        assert predictor.states[index]["orig_height"] == 160
    motion.read.return_value.__getitem__.assert_called_with(
        (slice(140, 300), slice(272, 528))
    )
    assert motion.accept.call_count == 2


@pytest.mark.parametrize(
    "case",
    [
        (0.4, 0.8, [118 / 256, 70 / 160, 20 / 256, 20 / 160], 0.4),
        (0.9, 0.6, [118 / 256, 70 / 160, 20 / 256, 20 / 160], 0.6),
        (0.9, 0.8, [118 / 256, 70 / 160, 10 / 256, 20 / 160], 0.5),
    ],
)
def test_score_uses_current_presence_motion_consistency_and_mask_agreement(
    motion_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    case: tuple[float, float, list[float], float],
) -> None:
    presence, consistency, box, expected = case
    predictor = _Predictor()
    predictor.presence, predictor.box = presence, box
    stream, _ = _track(
        motion_module,
        monkeypatch,
        tmp_path,
        predictor,
        [motion_module.MotionProposal((390, 210, 20, 20), consistency)],
    )
    (result,) = list(stream)
    assert result.score == expected


@pytest.mark.parametrize(
    "reason",
    [
        "missing-proposal",
        "ambiguous-proposal",
        "missing-mask",
        "disagreement",
        "nonfinite",
    ],
)
def test_rejection_stops_segment_without_updating_motion_and_closes_session(
    motion_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    reason: str,
) -> None:
    module = motion_module
    predictor = _Predictor()
    proposal = module.MotionProposal((390, 210, 20, 20), 0.8)
    if reason in {"missing-proposal", "ambiguous-proposal"}:
        # FixedCameraMotion returns None for either no match or a near-tie.
        proposal = None
    elif reason == "missing-mask":
        predictor.missing = True
    elif reason == "disagreement":
        predictor.box = [0.0, 0.0, 0.01, 0.01]
    else:
        predictor.presence = float("nan")
    stream, motion = _track(module, monkeypatch, tmp_path, predictor, [proposal])
    assert list(stream) == [Sam31FrameResult(box=None, score=0.0)]
    motion.accept.assert_not_called()
    assert predictor.requests[-1]["type"] == "close_session"


@pytest.mark.parametrize("finish", ["consumer-close", "model-error", "deadline"])
def test_interrupted_tracking_always_closes_its_model_session(
    motion_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    finish: str,
) -> None:
    module = motion_module
    predictor = _Predictor()
    proposal = module.MotionProposal((390, 210, 20, 20), 0.8)
    stream, _ = _track(module, monkeypatch, tmp_path, predictor, [proposal, proposal])
    if finish == "model-error":
        predictor.failure = RuntimeError("model failed")
        with pytest.raises(RuntimeError, match="model failed"):
            next(stream)
    else:
        assert next(stream).box is not None
        if finish == "deadline":
            monkeypatch.setattr(
                module, "_check_deadline", Mock(side_effect=InferenceFailureError)
            )
            with pytest.raises(InferenceFailureError):
                next(stream)
        else:
            stream.close()
    assert predictor.requests[-1]["type"] == "close_session"
    assert (
        sum(request["type"] == "close_session" for request in predictor.requests) == 1
    )


def test_expired_deadline_and_wrong_frame_count_do_not_open_sessions(
    motion_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    module = motion_module
    predictor = _Predictor()
    runtime = _runtime(module, monkeypatch, predictor)
    arguments = {
        "frame_directory": tmp_path,
        "seed_position": 0,
        "seed_box": (0.1, 0.1, 0.1, 0.1),
        "frame_count": 1,
    }
    with pytest.raises(InferenceFailureError):
        next(runtime.track(**arguments))
    (tmp_path / "0.jpg").touch()
    with pytest.raises(InferenceFailureError):
        next(runtime.track(**arguments, timeout_seconds=0.0))
    assert predictor.requests == []


@pytest.mark.parametrize(
    "case",
    [
        (1000, 500, (0, 0, 20, 20), (0, 0), (256, 160)),
        (1000, 500, (980, 480, 20, 20), (744, 340), (256, 160)),
        (100, 80, (90, 70, 10, 10), (0, 0), (100, 80)),
    ],
)
def test_crop_clamps_to_frame_edges_and_preserves_track_space(
    motion_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    case: tuple[int, int, tuple[int, int, int, int], tuple[int, int], tuple[int, int]],
) -> None:
    width, height, box, origin, size = case
    x, y, box_width, box_height = box
    left, top = origin
    crop_width, crop_height = size
    predictor = _Predictor()
    predictor.box = [
        (x - left) / crop_width,
        (y - top) / crop_height,
        box_width / crop_width,
        box_height / crop_height,
    ]
    runtime = _runtime(motion_module, monkeypatch, predictor)
    frame = MagicMock()
    result = runtime._refine(
        "subject",
        frame,
        SimpleNamespace(width=width, height=height),
        motion_module.MotionProposal(box, 0.8),
        None,
    )
    assert result.box == (x / width, y / height, box_width / width, box_height / height)
    assert result.score == 0.8
    frame.__getitem__.assert_called_once_with(
        (slice(top, top + crop_height), slice(left, left + crop_width))
    )


def test_recovery_rejects_low_confidence_before_motion_can_accept_it(
    motion_module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    predictor = _Predictor()
    predictor.presence = 0.2
    runtime = _runtime(motion_module, monkeypatch, predictor, recover_gaps=True)
    result = runtime._refine(
        "subject",
        MagicMock(),
        SimpleNamespace(width=1000, height=500),
        motion_module.MotionProposal((390, 210, 20, 20), 0.8),
        None,
    )
    assert result == Sam31FrameResult(box=None, score=0.0)
