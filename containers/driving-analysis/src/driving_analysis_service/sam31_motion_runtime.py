"""Motion continuity with independent SAM 3.1 mask verification per frame.

The motion proposal is not a human correction and never bridges a missing frame.
This mode has its own immutable profile semantics and confidence calibration.
"""

import math
import threading
import time
from collections.abc import Generator
from pathlib import Path

import cv2
from PIL import Image
from torchvision.transforms import functional as transforms

from driving_analysis_service.inference import InferenceFailureError
from driving_analysis_service.motion_proposals import FixedCameraMotion
from driving_analysis_service.sam31_inference import Sam31FrameResult
from driving_analysis_service.sam31_runtime import (
    _build_predictor,
    _check_deadline,
    _cuda_autocast,
    _frame_result,
)

MIN_MASK_AGREEMENT = 0.25


class Sam31MotionRuntime:
    def __init__(self, checkpoint: Path) -> None:
        self._predictor = _build_predictor(checkpoint)
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
        paths = tuple(
            sorted(frame_directory.glob("*.jpg"), key=lambda path: int(path.stem))
        )
        paths = paths[seed_position : seed_position + frame_count]
        if len(paths) != frame_count or not paths:
            raise InferenceFailureError
        with self._lock, _cuda_autocast():
            _check_deadline(deadline)
            motion = FixedCameraMotion(paths, seed_box)
            _check_deadline(deadline)
            # A single-image state keeps reset cost and memory independent of
            # race length. It is cleared before each machine-generated prompt.
            predictor = self._predictor
            session_id = predictor.handle_request(
                {
                    "type": "start_session",
                    "resource_path": str(paths[0]),
                    "offload_video_to_cpu": True,
                }
            )["session_id"]
            try:
                for path in paths:
                    _check_deadline(deadline)
                    frame = motion.read(path)
                    proposal = motion.propose(frame)
                    if proposal is None:
                        yield Sam31FrameResult(box=None, score=0.0)
                        return
                    x, y, width, height = proposal.box
                    crop_width, crop_height = (
                        min(256, motion.width),
                        min(160, motion.height),
                    )
                    left = round(
                        max(
                            0,
                            min(
                                motion.width - crop_width,
                                x + width / 2 - crop_width / 2,
                            ),
                        )
                    )
                    top = round(
                        max(
                            0,
                            min(
                                motion.height - crop_height,
                                y + height / 2 - crop_height / 2,
                            ),
                        )
                    )
                    crop = frame[top : top + crop_height, left : left + crop_width]
                    image = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
                    pixels = transforms.to_tensor(
                        transforms.resize(image, (1008, 1008))
                    ).half()
                    pixels = (pixels - 0.5) / 0.5
                    predictor.handle_request(
                        {"type": "reset_session", "session_id": session_id}
                    )
                    state = predictor._all_inference_states[session_id]["state"]  # noqa: SLF001 - pinned SAM adapter
                    state["orig_width"], state["orig_height"] = crop_width, crop_height
                    state["input_batch"].img_batch.tensors = pixels.unsqueeze(0)
                    response = predictor.handle_request(
                        {
                            "type": "add_prompt",
                            "session_id": session_id,
                            "frame_index": 0,
                            "points": [
                                [(x - left) / crop_width, (y - top) / crop_height],
                                [
                                    (x + width - left) / crop_width,
                                    (y + height - top) / crop_height,
                                ],
                            ],
                            "point_labels": [2, 3],
                            "obj_id": 1,
                        }
                    )
                    _check_deadline(deadline)
                    result = _frame_result(response["outputs"])
                    if result.box is None:
                        yield Sam31FrameResult(box=None, score=0.0)
                        return
                    bx, by, bw, bh = result.box
                    pixels_box = (
                        left + bx * crop_width,
                        top + by * crop_height,
                        bw * crop_width,
                        bh * crop_height,
                    )
                    agreement = _intersection_over_union(pixels_box, proposal.box)
                    tracked = state["sam2_inference_states"][0]["output_dict"][
                        "cond_frame_outputs"
                    ][0]
                    presence = float(
                        tracked["object_score_logits"].flatten()[0].sigmoid()
                    )
                    # This is a consistency score, not a calibrated identity
                    # probability. The profile names that distinction explicitly.
                    score = min(presence, proposal.consistency, agreement)
                    box = (
                        pixels_box[0] / motion.width,
                        pixels_box[1] / motion.height,
                        pixels_box[2] / motion.width,
                        pixels_box[3] / motion.height,
                    )
                    if agreement < MIN_MASK_AGREEMENT or not math.isfinite(score):
                        yield Sam31FrameResult(box=None, score=0.0)
                        return
                    motion.accept(proposal)
                    yield Sam31FrameResult(box=box, score=score)
            finally:
                predictor.handle_request(
                    {"type": "close_session", "session_id": session_id}
                )


def _intersection_over_union(
    left: tuple[float, float, float, float],
    right: tuple[int, int, int, int],
) -> float:
    ax, ay, aw, ah = left
    bx, by, bw, bh = right
    overlap = max(0.0, min(ax + aw, bx + bw) - max(ax, bx)) * max(
        0.0, min(ay + ah, by + bh) - max(ay, by)
    )
    union = aw * ah + bw * bh - overlap
    return overlap / union if union > 0 else 0.0
