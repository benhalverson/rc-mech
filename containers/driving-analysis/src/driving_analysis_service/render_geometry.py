"""Map immutable normalized Corner geometry to the codec's pixel grid."""

import math
from dataclasses import dataclass

from driving_analysis_service.geometry_contracts import DirectedGate, NormalizedPoint
from driving_analysis_service.media import ProbeMetadata
from driving_analysis_service.rendering_contracts import RenderSpecification
from driving_analysis_service.tracking_contracts import TRACK_VIEW_HEIGHT, TRACK_VIEW_Y

MIN_OUTPUT_DIMENSION = 2


@dataclass(frozen=True)
class PixelCrop:
    """Codec-aligned source-frame rectangle consumed by the Corner renderer.

    Keeps pixel geometry separate from immutable normalized Track-view inputs;
    it contains no process or artifact state.
    """

    width: int
    height: int
    x: int
    y: int


def pixel_crop(
    specification: RenderSpecification, metadata: ProbeMetadata
) -> PixelCrop:
    """Map the normalized Corner view to an enclosing even-pixel source crop.

    CornerRenderService uses this pure conversion before constructing FFmpeg
    filters. Minimum cells remain inside source bounds at the frame edges.
    """

    view = specification.corner_view
    # Enclose the immutable normalized view on the codec's even-pixel grid.
    # At a source boundary, keep the minimum two-pixel cell inside the frame.
    right = min(
        metadata.width // 2 * 2,
        math.ceil(metadata.width * (view.x + view.width) / 2) * 2,
    )
    bottom = min(
        metadata.height // 2 * 2,
        math.ceil(
            metadata.height
            * (TRACK_VIEW_Y + (view.y + view.height) * TRACK_VIEW_HEIGHT)
            / 2
        )
        * 2,
    )
    left = min(int(metadata.width * view.x) // 2 * 2, right - MIN_OUTPUT_DIMENSION)
    top = min(
        int(metadata.height * (TRACK_VIEW_Y + view.y * TRACK_VIEW_HEIGHT)) // 2 * 2,
        bottom - MIN_OUTPUT_DIMENSION,
    )
    return PixelCrop(
        width=right - left,
        height=bottom - top,
        x=left,
        y=top,
    )


def pixel_point(
    point: NormalizedPoint, metadata: ProbeMetadata, crop: PixelCrop
) -> tuple[int, int]:
    """Translate a normalized Track-view point into crop-local overlay pixels.

    The renderer supplies source dimensions and the chosen crop, so overlay
    geometry cannot accidentally use full-frame coordinates as Track-view ones.
    """

    frame_y = TRACK_VIEW_Y + point.y * TRACK_VIEW_HEIGHT
    return (
        round(point.x * metadata.width) - crop.x,
        round(frame_y * metadata.height) - crop.y,
    )


def pixel_gate(
    gate: DirectedGate, metadata: ProbeMetadata, crop: PixelCrop
) -> tuple[tuple[int, int], tuple[int, int]]:
    """Convert both endpoints of a directed gate using the same crop transform.

    The overlay writer consumes the pair; gate direction and crossing semantics
    remain in the normalized contract rather than this pixel conversion.
    """

    return (
        pixel_point(gate.entry, metadata, crop),
        pixel_point(gate.exit, metadata, crop),
    )
