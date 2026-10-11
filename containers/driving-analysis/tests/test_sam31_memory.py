from collections.abc import Generator
from types import SimpleNamespace

import pytest

from driving_analysis_service.sam31_memory import (
    bound_forward_tracking_memory,
    prune_tracking_history,
)


def _state() -> dict:
    outputs = {"cond_frame_outputs": {0: object()}, "non_cond_frame_outputs": {}}
    per_object = {"cond_frame_outputs": {0: object()}, "non_cond_frame_outputs": {}}
    return {
        "num_frames": 12000,
        "cached_frame_outputs": {},
        "sam2_inference_states": [
            {
                "output_dict": outputs,
                "output_dict_per_obj": {0: per_object},
            }
        ],
    }


def test_full_race_retains_attention_window_and_conditioning_only() -> None:
    state = _state()
    tracker = SimpleNamespace(
        num_maskmem=7,
        max_obj_ptrs_in_encoder=16,
        memory_temporal_stride_for_eval=2,
        use_memory_selection=False,
    )
    tracking = state["sam2_inference_states"][0]
    for frame in range(12000):
        for output in (tracking["output_dict"], tracking["output_dict_per_obj"][0]):
            output["non_cond_frame_outputs"][frame] = object()
        state["cached_frame_outputs"][frame] = object()
        prune_tracking_history(state, tracker, frame)
        assert len(tracking["output_dict"]["non_cond_frame_outputs"]) <= 17
        assert set(tracking["output_dict"]["cond_frame_outputs"]) == {0}
        assert len(state["cached_frame_outputs"]) == 1
    expected = set(range(11983, 12000))
    assert set(tracking["output_dict"]["non_cond_frame_outputs"]) == expected
    assert set(tracking["output_dict_per_obj"][0]["non_cond_frame_outputs"]) == expected


def test_old_confident_frames_survive_for_each_memory_selection_stride_phase() -> None:
    state = _state()
    tracking = state["sam2_inference_states"][0]
    tracking["output_dict"]["non_cond_frame_outputs"] = dict.fromkeys(range(50))
    tracking["output_dict_per_obj"][0]["non_cond_frame_outputs"] = dict.fromkeys(
        range(50)
    )
    phases = []

    def select(
        output: dict,
        reverse: bool,  # noqa: FBT001 - upstream signature
        frame: int,
        count: int,
        stride: int,
    ) -> list[int]:
        assert output is tracking["output_dict"]
        assert not reverse
        assert count == 12000
        assert stride == 2
        phases.append(frame)
        return [frame % 2 + 1]

    tracker = SimpleNamespace(
        num_maskmem=7,
        max_obj_ptrs_in_encoder=16,
        memory_temporal_stride_for_eval=2,
        use_memory_selection=True,
        frame_filter=select,
    )
    prune_tracking_history(state, tracker, 49)
    assert phases == [50, 51]
    assert set(tracking["output_dict"]["non_cond_frame_outputs"]) == {
        1,
        2,
        *range(33, 50),
    }


def test_forward_adapter_preserves_outputs_and_closes_underlying_stream() -> None:
    state = _state()
    closed = []
    output = object()

    def propagate(inference_state: dict, **kwargs: object) -> Generator:
        assert inference_state is state
        assert kwargs == {"reverse": False}
        try:
            yield 1, output
            yield 2, output
        finally:
            closed.append(True)

    model = SimpleNamespace(
        tracker=SimpleNamespace(
            num_maskmem=7,
            max_obj_ptrs_in_encoder=16,
            memory_temporal_stride_for_eval=1,
            use_memory_selection=False,
        ),
        propagate_in_video=propagate,
    )
    bound_forward_tracking_memory(model)
    assert list(model.propagate_in_video(state, reverse=False)) == [
        (1, output),
        (2, output),
    ]
    stream = model.propagate_in_video(state, reverse=False)
    assert next(stream) == (1, output)
    stream.close()
    assert closed == [True, True]
    with pytest.raises(ValueError, match="forward propagation"):
        next(model.propagate_in_video(state, reverse=True))
