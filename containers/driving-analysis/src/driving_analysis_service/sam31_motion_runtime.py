"""Motion continuity with independent SAM 3.1 mask verification per frame.

The motion proposal is not a human correction and never bridges a missing frame.
This mode has its own immutable profile semantics and confidence calibration.
"""

import math
import threading
import time
from collections.abc import Generator
from dataclasses import dataclass
from pathlib import Path
from typing import Self

import cv2
import numpy as np
from numpy.typing import NDArray
from PIL import Image
from torchvision.transforms import functional as transforms

from driving_analysis_service.inference import InferenceFailureError
from driving_analysis_service.motion_proposals import (
    FOREGROUND_THRESHOLD,
    FixedCameraMotion,
    MotionProposal,
)
from driving_analysis_service.sam31_inference import Sam31FrameResult
from driving_analysis_service.sam31_person_exclusion import (
    PERSON_CAPACITY,
    PersonExclusion,
)
from driving_analysis_service.sam31_runtime import (
    _build_predictor,
    _check_deadline,
    _cuda_autocast,
    _frame_result,
)

MIN_MASK_AGREEMENT = 0.25
MIN_RECOVERY_APPEARANCE = 0.75
ACHROMATIC_SATURATION = 64
MIN_RECOVERY_SPEED_SQUARED = 4
RECOVERY_CONFIRMATION_FRAMES = 3
MAX_CONTINUOUS_ASPECT_CHANGE = 2.0


@dataclass
class _RecoveryState:
    position: int
    center: NDArray[np.float64]
    size: NDArray[np.float64]
    velocity: NDArray[np.float64]
    appearance: NDArray[np.float32] | None
    first_center: NDArray[np.float64]
    confirmed: int = 0

    def continues(self, proposal: MotionProposal) -> bool:
        speed_squared = float(np.dot(self.velocity, self.velocity))
        if speed_squared < MIN_RECOVERY_SPEED_SQUARED:
            return True
        x, y, width, height = proposal.box
        displacement = np.array([x + width / 2, y + height / 2]) - self.first_center
        # A moving car cannot be recovered onto a stationary sleeve or shoe.
        # Keep the original velocity until all confirmation frames agree.
        progress = float(np.dot(displacement, self.velocity)) / speed_squared
        return progress >= 0.25 * self.confirmed

    def confirm(self) -> Self | None:
        self.confirmed += 1
        return None if self.confirmed == RECOVERY_CONFIRMATION_FRAMES else self


class Sam31MotionRuntime:
    def __init__(
        self, checkpoint: Path, *, recover_gaps: bool = False, threshold: float = 0.3
    ) -> None:
        self._predictor = _build_predictor(
            checkpoint, max_num_objects=PERSON_CAPACITY if recover_gaps else 1
        )
        self._lock = threading.Lock()
        self._recover_gaps = recover_gaps
        self._threshold = threshold

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
            elapsed_frames = 1
            appearance = None
            recovery = None
            previous_box = None
            _check_deadline(deadline)
            # A single-image state keeps reset cost and memory independent of
            # race length. It is cleared before each machine-generated prompt.
            predictor = self._predictor
            people = PersonExclusion(
                predictor if self._recover_gaps else None, motion.width, motion.height
            )
            session_id = predictor.handle_request(
                {
                    "type": "start_session",
                    "resource_path": str(paths[0]),
                    "offload_video_to_cpu": True,
                }
            )["session_id"]
            try:
                for index, path in enumerate(paths):
                    _check_deadline(deadline)
                    people.refresh(index, path)
                    frame = motion.read(path)
                    proposal = self._proposal(
                        motion, frame, first=index == 0, elapsed_frames=elapsed_frames
                    )
                    if (
                        proposal is None
                        or people.blocks(proposal.box, index, path)
                        or (recovery is not None and not recovery.continues(proposal))
                    ):
                        yield Sam31FrameResult(box=None, score=0.0)
                        if not self._recover_gaps:
                            return
                        elapsed_frames, appearance, recovery = _missed_frame(
                            motion, recovery, appearance, index, elapsed_frames
                        )
                        continue
                    candidate_appearance = _appearance(frame, proposal.box, motion)
                    if (
                        elapsed_frames > 1
                        and appearance is not None
                        and float(np.dot(appearance, candidate_appearance))
                        < MIN_RECOVERY_APPEARANCE
                    ):
                        yield Sam31FrameResult(box=None, score=0.0)
                        elapsed_frames, appearance, recovery = _missed_frame(
                            motion, recovery, appearance, index, elapsed_frames
                        )
                        continue
                    result = _validate_continuous_shape(
                        people.filter(
                            self._refine(session_id, frame, motion, proposal, deadline)
                        ),
                        previous_box
                        if self._recover_gaps
                        and elapsed_frames == 1
                        and recovery is None
                        else None,
                    )
                    if result.box is None:
                        yield result
                        if not self._recover_gaps:
                            return
                        elapsed_frames, appearance, recovery = _missed_frame(
                            motion, recovery, appearance, index, elapsed_frames
                        )
                        continue
                    if self._recover_gaps and elapsed_frames > 1 and recovery is None:
                        recovery = _RecoveryState(
                            index - elapsed_frames,
                            motion.center.copy(),
                            motion.size.copy(),
                            motion.velocity.copy(),
                            None if appearance is None else appearance.copy(),
                            np.array(
                                [
                                    proposal.box[0] + proposal.box[2] / 2,
                                    proposal.box[1] + proposal.box[3] / 2,
                                ]
                            ),
                        )
                    previous_box = result.box
                    motion.accept(proposal, elapsed_frames=elapsed_frames)
                    elapsed_frames = 1
                    appearance = (
                        candidate_appearance
                        if appearance is None
                        else (0.9 * appearance + 0.1 * candidate_appearance)
                    )
                    appearance /= max(float(np.linalg.norm(appearance)), 1e-12)
                    if recovery is not None:
                        recovery = recovery.confirm()
                    yield result
            finally:
                predictor.handle_request(
                    {"type": "close_session", "session_id": session_id}
                )

    def _proposal(
        self,
        motion: FixedCameraMotion,
        frame: NDArray[np.uint8],
        *,
        first: bool,
        elapsed_frames: int,
    ) -> MotionProposal | None:
        if self._recover_gaps and first:
            # The human-selected seed is authoritative input to SAM. Foreground
            # fragmentation must not prevent the model from evaluating it.
            width, height = motion.size
            x, y = motion.center - motion.size / 2
            return MotionProposal(
                (round(x), round(y), max(1, round(width)), max(1, round(height))),
                1.0,
            )
        return motion.propose(frame, elapsed_frames=elapsed_frames)

    def _refine(
        self,
        session_id: str,
        frame: NDArray[np.uint8],
        motion: FixedCameraMotion,
        proposal: MotionProposal,
        deadline: float | None,
    ) -> Sam31FrameResult:
        predictor = self._predictor
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
        pixels = transforms.to_tensor(transforms.resize(image, (1008, 1008))).half()
        pixels = (pixels - 0.5) / 0.5
        predictor.handle_request({"type": "reset_session", "session_id": session_id})
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
            return Sam31FrameResult(box=None, score=0.0)
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
        presence = float(tracked["object_score_logits"].flatten()[0].sigmoid())
        # This is a consistency score, not a calibrated identity
        # probability. The profile names that distinction explicitly.
        score = min(presence, proposal.consistency, agreement)
        box = (
            pixels_box[0] / motion.width,
            pixels_box[1] / motion.height,
            pixels_box[2] / motion.width,
            pixels_box[3] / motion.height,
        )
        if (
            agreement < MIN_MASK_AGREEMENT
            or not math.isfinite(score)
            or (self._recover_gaps and score < self._threshold)
        ):
            return Sam31FrameResult(box=None, score=0.0)
        return Sam31FrameResult(box=box, score=score)


def _validate_continuous_shape(
    result: Sam31FrameResult,
    previous_box: tuple[float, float, float, float] | None,
) -> Sam31FrameResult:
    if (
        previous_box is not None
        and result.box is not None
        and not _continuous_shape_is_plausible(result.box, previous_box)
    ):
        # Reject before updating motion or appearance. Recovery must retain
        # the last trusted car state rather than follow an occluding limb.
        return Sam31FrameResult(box=None, score=0.0)
    return result


def _continuous_shape_is_plausible(
    box: tuple[float, float, float, float],
    previous_box: tuple[float, float, float, float],
) -> bool:
    # Compare aspect ratios, not area alone. Perspective scale cancels out;
    # legitimate turns may change orientation gradually. Across missing frames
    # the separate bounded recovery and confirmation checks apply instead.
    if min(box[2], box[3], previous_box[2], previous_box[3]) <= 0:
        return False
    aspect_change = (box[2] * previous_box[3]) / (box[3] * previous_box[2])
    return (
        1 / MAX_CONTINUOUS_ASPECT_CHANGE
        <= aspect_change
        <= MAX_CONTINUOUS_ASPECT_CHANGE
    )


def _missed_frame(
    motion: FixedCameraMotion,
    recovery: _RecoveryState | None,
    appearance: NDArray[np.float32] | None,
    index: int,
    elapsed_frames: int,
) -> tuple[int, NDArray[np.float32] | None, None]:
    if recovery is None:
        return elapsed_frames + 1, appearance, None
    # An unconfirmed flash must not redirect the search or alter its reference.
    motion.center = recovery.center
    motion.size = recovery.size
    motion.velocity = recovery.velocity
    return index - recovery.position + 1, recovery.appearance, None


def _appearance(
    frame: NDArray[np.uint8],
    box: tuple[int, int, int, int],
    motion: FixedCameraMotion,
) -> NDArray[np.float32]:
    """Compare visible foreground color; predicted positions never become boxes."""
    x, y, width, height = box
    patch = frame[y : y + height, x : x + width]
    delta = (
        motion.gray(patch).astype(np.int16)
        - motion.background[y : y + height, x : x + width]
    )
    mask = ((delta * motion.polarity) > FOREGROUND_THRESHOLD).astype(np.uint8)
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    # Hue is undefined near gray/white. Compression noise must not turn the
    # same white car into a different color after an occlusion.
    hsv[:, :, 0][hsv[:, :, 1] < ACHROMATIC_SATURATION] = 0
    histogram = cv2.calcHist(
        [hsv], [0, 1, 2], mask, [12, 4, 4], [0, 180, 0, 256, 0, 256]
    ).flatten()
    return histogram / max(float(np.linalg.norm(histogram)), 1e-12)


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
