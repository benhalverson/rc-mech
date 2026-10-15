from unittest.mock import Mock

import pytest

from driving_analysis_service.inference import InferenceFailureError
from driving_analysis_service.sam31_confidence import use_frame_tracking_confidence


def test_current_scores_follow_filtered_ids_without_changing_upstream_scores() -> None:
    logits = {1: Mock(item=Mock(return_value=-5.0)), 2: 4.0, 3: 10.0}
    upstream = {"obj_id_to_score": {1: 1.0}, "obj_id_to_sam2_score": logits}
    postprocess = Mock(return_value={"out_obj_ids": [2, 1, 4], "out_probs": [1] * 3})
    result = use_frame_tracking_confidence(postprocess)({}, upstream)
    assert result["out_probs"] == pytest.approx([0.98201379, 0.00669285, 0.0])
    assert upstream["obj_id_to_score"] == {1: 1.0}
    assert upstream["obj_id_to_sam2_score"] is logits


@pytest.mark.parametrize(("logit", "expected"), [(1000, 1.0), (-1000, 0.0), (0, 0.5)])
def test_extreme_presence_logits_are_stable(logit: float, expected: float) -> None:
    postprocess = Mock(return_value={"out_obj_ids": [1]})
    result = use_frame_tracking_confidence(postprocess)(
        {}, {"obj_id_to_sam2_score": {1: logit}}
    )
    assert result["out_probs"] == [expected]


@pytest.mark.parametrize("logit", [float("nan"), float("inf"), True, "1"])
def test_invalid_presence_is_rejected(logit: object) -> None:
    postprocess = Mock(return_value={"out_obj_ids": [1]})
    with pytest.raises(InferenceFailureError):
        use_frame_tracking_confidence(postprocess)(
            {}, {"obj_id_to_sam2_score": {1: logit}}
        )


def test_absent_score_map_fails_closed_and_empty_output_stays_empty() -> None:
    postprocess = Mock(return_value={"out_obj_ids": []})
    adapted = use_frame_tracking_confidence(postprocess)
    with pytest.raises(InferenceFailureError):
        adapted({}, {})
    assert adapted({}, {"obj_id_to_sam2_score": {}})["out_probs"] == []
