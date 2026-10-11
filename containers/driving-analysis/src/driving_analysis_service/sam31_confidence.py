"""Expose per-frame object presence from SAM 3.1 point propagation."""

import math
from collections.abc import Callable, Mapping
from typing import Protocol, runtime_checkable

from driving_analysis_service.inference import InferenceFailureError


@runtime_checkable
class _ScalarTensor(Protocol):
    def item(self) -> object: ...


def use_frame_tracking_confidence(
    postprocess: Callable[..., dict],
) -> Callable[..., dict]:
    """Keep upstream mask filtering, but replace its static prompt score.

    The pinned multiplex point path stores object-presence logits in
    obj_id_to_sam2_score. Its public out_probs instead repeats the original
    prompt/detection score (1.0 for a user seed), even after losing the car.
    Presence is necessary, but does not prove identity; geometry checks still
    apply after this adapter. Do not change scores used internally by SAM.
    """

    def with_frame_scores(
        inference_state: dict, out: dict, *args: object, **kwargs: object
    ) -> dict:
        result = postprocess(inference_state, out, *args, **kwargs)
        logits = out.get("obj_id_to_sam2_score")
        if not isinstance(logits, Mapping):
            raise InferenceFailureError
        # Use the postprocessed IDs: hidden, removed and empty masks have
        # already been excluded, and their original ordering need not match.
        result["out_probs"] = [
            _presence_probability(logits[object_id]) if object_id in logits else 0.0
            for object_id in result["out_obj_ids"]
        ]
        return result

    return with_frame_scores


def _presence_probability(value: object) -> float:
    if isinstance(value, _ScalarTensor):
        value = value.item()
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InferenceFailureError
    if not math.isfinite(value):
        raise InferenceFailureError
    # Stable sigmoid for either sign, including large negative logits.
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exponential = math.exp(value)
    return exponential / (1.0 + exponential)
