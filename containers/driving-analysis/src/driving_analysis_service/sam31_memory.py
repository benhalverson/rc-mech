"""Release unreachable tracking history during forward-only point tracking."""

from collections.abc import Callable, Generator
from typing import Protocol, cast


class _Tracker(Protocol):
    num_maskmem: int
    max_obj_ptrs_in_encoder: int
    memory_temporal_stride_for_eval: int
    use_memory_selection: bool

    def frame_filter(
        self,
        output: dict,
        reverse: bool,  # noqa: FBT001 - upstream signature
        frame: int,
        count: int,
        stride: int,
    ) -> list[int]: ...


class _Model(Protocol):
    tracker: _Tracker
    propagate_in_video: Callable[..., Generator]


def bound_forward_tracking_memory(model: object) -> None:
    """Preserve conditioning and every frame eligible for future attention.

    Each application segment is a new session with one seed and monotonically
    forward propagation. It never replays old masks or adds correction prompts
    to that session. Corrections create separate segments/sessions instead.
    """
    target = cast("_Model", model)
    original = target.propagate_in_video
    tracker = target.tracker

    def propagate(inference_state: dict, *args: object, **kwargs: object) -> Generator:
        if kwargs.get("reverse", False):
            message = "Bounded tracking sessions only support forward propagation"
            raise ValueError(message)
        stream = original(inference_state, *args, **kwargs)
        try:
            for frame_index, output in stream:
                yield frame_index, output
                prune_tracking_history(inference_state, tracker, frame_index)
        finally:
            stream.close()

    target.propagate_in_video = propagate


def prune_tracking_history(state: dict, tracker: _Tracker, frame: int) -> None:
    stride = tracker.memory_temporal_stride_for_eval
    horizon = max(stride * tracker.num_maskmem, tracker.max_obj_ptrs_in_encoder)
    recent = set(range(max(0, frame - horizon), frame + 1))
    for tracking_state in state["sam2_inference_states"]:
        output = tracking_state["output_dict"]
        keep = recent.copy()
        if tracker.use_memory_selection:
            # Preserve the newest qualifying memories in every stride phase.
            # A future low-confidence stretch may still attend to these old
            # frames, so a fixed-age eviction alone would change inference.
            for offset in range(1, stride + 1):
                keep.update(
                    tracker.frame_filter(
                        output,
                        False,  # noqa: FBT003 - upstream signature
                        frame + offset,
                        state["num_frames"],
                        stride,
                    )
                )
        stores = [output, *tracking_state["output_dict_per_obj"].values()]
        for store in stores:
            history = store["non_cond_frame_outputs"]
            for index in tuple(history):
                if index not in keep:
                    del history[index]
    # Full-resolution display masks are already converted to compact output.
    # They are not the recurrent attention memory retained above.
    display = state["cached_frame_outputs"]
    for index in tuple(display):
        if index != frame:
            del display[index]
