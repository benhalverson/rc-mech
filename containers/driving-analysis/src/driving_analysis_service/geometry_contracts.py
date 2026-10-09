"""Shared coordinate and timing shapes used by media, tracking, and benchmark
contracts.

Model responsibilities (kept here to preserve generated schema descriptions):
RationalValue: Carries exact frame-rate/time-base fractions without reducing them to
    floating-point timing.
NormalizedPoint: Bounds a point to the normalized coordinate space used by gates and
    observations.
NormalizedBox: Bounds a nonempty subject/view rectangle and rejects boxes outside
    the
    normalized frame.
DirectedGate: Pairs noncoincident endpoints with crossing direction for
    deterministic
    pass detection.
CornerGates: Keeps the entry/exit gate pair together for one Corner.
SubjectSeed: Binds the selected identity/box to an absolute source timestamp and
    decoded-frame index.
"""
# ruff: noqa: EM101, TRY003

from typing import Annotated, Literal

from pydantic import (
    Field,
    model_validator,
)

from driving_analysis_service.contract_primitives import (
    MAX_BENCHMARK_FRAME_COUNT,
    MAX_BENCHMARK_TIMESTAMP_MS,
    MIN_NORMALIZED_BOX_AREA,
    SafeFreeFormIdentifier,
    StrictContract,
)


class RationalValue(StrictContract):
    numerator: int
    denominator: Annotated[int, Field(gt=0, strict=True)]


class NormalizedPoint(StrictContract):
    x: float = Field(ge=0.0, le=1.0, strict=True)
    y: float = Field(ge=0.0, le=1.0, strict=True)


class NormalizedBox(StrictContract):
    x: float = Field(ge=0.0, lt=1.0, strict=True)
    y: float = Field(ge=0.0, lt=1.0, strict=True)
    width: float = Field(gt=0.0, le=1.0, strict=True)
    height: float = Field(gt=0.0, le=1.0, strict=True)

    @model_validator(mode="after")
    def fits_in_frame(self) -> "NormalizedBox":
        if self.x + self.width > 1.0 or self.y + self.height > 1.0:
            raise ValueError("box must fit in normalized frame")
        if self.width * self.height < MIN_NORMALIZED_BOX_AREA:
            raise ValueError("box area is below the normalized minimum")
        return self


class DirectedGate(StrictContract):
    entry: NormalizedPoint
    exit: NormalizedPoint
    direction: Literal["positive", "negative"]

    @model_validator(mode="after")
    def non_degenerate(self) -> "DirectedGate":
        if self.entry == self.exit:
            raise ValueError("gate must have two distinct points")
        return self


class CornerGates(StrictContract):
    entry: DirectedGate
    exit: DirectedGate


class SubjectSeed(StrictContract):
    timestamp_ms: int = Field(
        alias="timestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    frame_index: int = Field(
        alias="frameIndex", ge=0, lt=MAX_BENCHMARK_FRAME_COUNT, strict=True
    )
    identity: SafeFreeFormIdentifier
    box: NormalizedBox
