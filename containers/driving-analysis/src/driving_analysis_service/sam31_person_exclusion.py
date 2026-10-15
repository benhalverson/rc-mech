"""Bounded semantic person exclusion for the fixed-camera car tracker."""

import math
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from driving_analysis_service.inference import InferenceFailureError
from driving_analysis_service.sam31_inference import Sam31FrameResult
from driving_analysis_service.sam31_runtime import (
    _list,
    _mapping,
    _number,
    _Predictor,
)

PERSON_CAPACITY = 16
PERSON_REFRESH_FRAMES = 5
PERSON_REFRESH_MARGIN_PIXELS = 48
PERSON_EXCLUSION_MARGIN_PIXELS = 2
MIN_PERSON_TO_CANDIDATE_HEIGHT = 1.5
BOX_VALUE_COUNT = 4


class PersonExclusion:
    def __init__(self, predictor: _Predictor | None, width: int, height: int) -> None:
        self._predictor = predictor
        self._width = width
        self._height = height
        self._last_refresh = -1
        self._boxes: tuple[tuple[float, float, float, float], ...] = ()
        self._masks: NDArray[np.bool_] | None = None

    def refresh(self, index: int, path: Path, *, force: bool = False) -> None:
        predictor = self._predictor
        if predictor is None or (not force and index % PERSON_REFRESH_FRAMES):
            return
        session_id = predictor.handle_request(
            {
                "type": "start_session",
                "resource_path": str(path),
                "offload_video_to_cpu": True,
            }
        )["session_id"]
        try:
            response = predictor.handle_request(
                {
                    "type": "add_prompt",
                    "session_id": session_id,
                    "frame_index": 0,
                    "text": "person",
                }
            )
            outputs = _mapping(response["outputs"])
            boxes = []
            for raw in _list(outputs.get("out_boxes_xywh")):
                values = _list(raw)
                if len(values) != BOX_VALUE_COUNT:
                    raise InferenceFailureError
                box = tuple(_number(value) for value in values)
                boxes.append((box[0], box[1], box[2], box[3]))
            masks = np.asarray(outputs.get("out_binary_masks"))
            if (
                len(boxes) > PERSON_CAPACITY
                or masks.dtype != np.bool_
                or masks.shape != (len(boxes), self._height, self._width)
            ):
                raise InferenceFailureError
            self._boxes = tuple(boxes)
            # SAM may reuse its CPU output buffer on the next request.
            self._masks = masks.copy()
            self._last_refresh = index
        finally:
            predictor.handle_request(
                {"type": "close_session", "session_id": session_id}
            )

    def blocks(self, box: tuple[int, int, int, int], index: int, path: Path) -> bool:
        x, y, width, height = box
        normalized = (
            x / self._width,
            y / self._height,
            width / self._width,
            height / self._height,
        )
        if self._last_refresh != index and self._overlaps(
            normalized, PERSON_REFRESH_MARGIN_PIXELS
        ):
            self.refresh(index, path, force=True)
        return self._overlaps(
            normalized, PERSON_EXCLUSION_MARGIN_PIXELS, require_mask=True
        )

    def filter(self, result: Sam31FrameResult) -> Sam31FrameResult:
        if result.box is not None and self._overlaps(
            result.box, PERSON_EXCLUSION_MARGIN_PIXELS, require_mask=True
        ):
            return Sam31FrameResult(box=None, score=0.0)
        return result

    def _overlaps(
        self,
        box: tuple[float, float, float, float],
        margin_pixels: int,
        *,
        require_mask: bool = False,
    ) -> bool:
        x, y, width, height = box
        margin_x = margin_pixels / self._width
        margin_y = margin_pixels / self._height
        # Expanded bounds trigger a fresh semantic check when the car is near
        # a moving person. The final decision requires occupied mask pixels;
        # empty corners of a spectator rectangle must not exclude a nearby car.
        return any(
            # SAM can label a car-sized mask as a person. A semantic label alone
            # must not veto the human-selected car: an occluding person region
            # must be taller than the candidate at that same image location.
            ph >= height * MIN_PERSON_TO_CANDIDATE_HEIGHT
            and x < px + pw + margin_x
            and x + width > px - margin_x
            and y < py + ph + margin_y
            and y + height > py - margin_y
            and (
                not require_mask or self._mask_overlaps(index, box, margin_pixels)
            )
            for index, (px, py, pw, ph) in enumerate(self._boxes)
        )

    def _mask_overlaps(
        self,
        index: int,
        box: tuple[float, float, float, float],
        margin_pixels: int,
    ) -> bool:
        masks = self._masks
        if masks is None:
            raise InferenceFailureError
        x, y, width, height = box
        left = max(0, math.floor(x * self._width) - margin_pixels)
        top = max(0, math.floor(y * self._height) - margin_pixels)
        right = min(self._width, math.ceil((x + width) * self._width) + margin_pixels)
        bottom = min(self._height, math.ceil((y + height) * self._height) + margin_pixels)
        return bool(np.any(masks[index, top:bottom, left:right]))
