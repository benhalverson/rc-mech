"""Conservative motion proposals for a user-seeded car in a fixed camera view.

Proposals position SAM prompts; they are never accepted observations by themselves.
A missing or ambiguous proposal ends the segment instead of reacquiring another car.
"""

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from numpy.typing import NDArray

CAMERA_CHANGE_THRESHOLD = 20
FOREGROUND_THRESHOLD = 25
MIN_COMPONENT_AREA = 12
MAX_COMPONENT_AREA = 10000
MIN_COMPONENT_WIDTH = 4
MAX_COMPONENT_WIDTH = 240
MIN_COMPONENT_HEIGHT = 3
MAX_COMPONENT_HEIGHT = 180
MIN_SIZE_RATIO = 0.2
MAX_SIZE_RATIO = 4
AMBIGUITY_MARGIN_PIXELS = 4


@dataclass(frozen=True)
class MotionProposal:
    box: tuple[int, int, int, int]
    consistency: float


class FixedCameraMotion:
    def __init__(
        self,
        paths: tuple[Path, ...],
        seed: tuple[float, float, float, float],
    ) -> None:
        first = self.read(paths[0])
        self.height, self.width = first.shape[:2]
        x, y, width, height = seed
        self.center = np.array(
            [(x + width / 2) * self.width, (y + height / 2) * self.height]
        )
        self.size = np.array([width * self.width, height * self.height])
        self.velocity = np.zeros(2)
        # The full recording is already available. Sample bounded, future frames
        # so a stationary car on the starting grid is not baked into background.
        end = min(len(paths) - 1, 900)
        start = min(60, end)
        indices = np.unique(np.linspace(start, end, min(45, end + 1)).astype(int))
        samples = [self.gray(self.read(paths[int(index)])) for index in indices]
        self.background = np.median(np.stack(samples), axis=0).astype(np.int16)
        delta = self.gray(first).astype(np.int16) - self.background
        left, top = int(x * self.width), int(y * self.height)
        patch = delta[
            top : max(top + 1, int((y + height) * self.height)),
            left : max(left + 1, int((x + width) * self.width)),
        ]
        self.polarity = (
            1 if np.maximum(patch, 0).sum() >= -np.minimum(patch, 0).sum() else -1
        )

    @staticmethod
    def read(path: Path) -> NDArray[np.uint8]:
        frame = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if frame is None:
            message = "Prepared motion frame is unreadable"
            raise ValueError(message)
        return frame

    @staticmethod
    def gray(frame: NDArray[np.uint8]) -> NDArray[np.uint8]:
        return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    def propose(
        self, frame: NDArray[np.uint8], *, elapsed_frames: int = 1
    ) -> MotionProposal | None:
        if frame.shape[:2] != (self.height, self.width):
            message = "Prepared motion frame dimensions changed"
            raise ValueError(message)
        delta = self.gray(frame).astype(np.int16) - self.background
        # A moving camera or a scene cut invalidates fixed-background evidence.
        if np.median(np.abs(delta)) > CAMERA_CHANGE_THRESHOLD:
            return None
        mask = ((delta * self.polarity) > FOREGROUND_THRESHOLD).astype(np.uint8)
        mask = cv2.dilate(mask, np.ones((5, 5), dtype=np.uint8))
        groups = _components(mask)

        radius = max(18.0, float(np.linalg.norm(self.size)) * 1.3) + min(
            60.0, 2.0 * (elapsed_frames - 1)
        )
        prediction = self.center + self.velocity * elapsed_frames
        candidates: list[tuple[float, tuple[int, int, int, int]]] = []
        for x, y, width, height, area in groups:
            if not _plausible_component(width, height, area):
                continue
            if (
                not MIN_SIZE_RATIO
                <= (width * height) / float(np.prod(self.size))
                <= MAX_SIZE_RATIO
            ):
                continue
            center = np.array([x + width / 2, y + height / 2])
            distance = float(np.linalg.norm(center - prediction))
            if distance <= radius:
                candidates.append((distance, (x, y, width, height)))
        candidates.sort()
        if not candidates:
            return None
        if (
            len(candidates) > 1
            and candidates[1][0] - candidates[0][0] < AMBIGUITY_MARGIN_PIXELS
        ):
            return None
        distance, box = candidates[0]
        return MotionProposal(box=box, consistency=max(0.0, 1 - distance / radius))

    def accept(self, proposal: MotionProposal, *, elapsed_frames: int = 1) -> None:
        """Advance identity state only after SAM also accepts the proposal."""
        x, y, width, height = proposal.box
        center = np.array([x + width / 2, y + height / 2])
        self.velocity = 0.45 * self.velocity + 0.55 * (
            (center - self.center) / elapsed_frames
        )
        self.center = center
        self.size = 0.8 * self.size + 0.2 * np.array([width, height])


def _plausible_component(width: int, height: int, area: int) -> bool:
    return (
        MIN_COMPONENT_AREA <= area <= MAX_COMPONENT_AREA
        and MIN_COMPONENT_WIDTH <= width <= MAX_COMPONENT_WIDTH
        and MIN_COMPONENT_HEIGHT <= height <= MAX_COMPONENT_HEIGHT
    )


def _components(mask: NDArray[np.uint8]) -> list[list[int]]:
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    groups: list[list[int]] = []
    for index in sorted(range(1, count), key=lambda item: -stats[item, 4]):
        x, y, width, height, area = map(int, stats[index])
        if not _plausible_component(width, height, area):
            continue
        for group in groups:
            gx, gy, gw, gh, ga = group
            if x <= gx + gw and gx <= x + width and y <= gy + gh and gy <= y + height:
                right, bottom = max(gx + gw, x + width), max(gy + gh, y + height)
                group[:] = [
                    min(gx, x),
                    min(gy, y),
                    right - min(gx, x),
                    bottom - min(gy, y),
                    ga + area,
                ]
                break
        else:
            groups.append([x, y, width, height, area])

    return groups
