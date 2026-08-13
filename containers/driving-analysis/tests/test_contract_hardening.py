import math
from typing import cast

import pytest
from pydantic import TypeAdapter, ValidationError

from driving_analysis_service.contracts import (
    MAX_BENCHMARK_FRAME_COUNT,
    MAX_BENCHMARK_TIMESTAMP_MS,
    MIN_NORMALIZED_BOX_AREA,
    BenchmarkCase,
    CorpusRecording,
    GateTimingMetrics,
    GroundTruthPass,
    NormalizedBox,
    RationalValue,
    SafeError,
    SafeFreeFormIdentifier,
    SubjectErrorCode,
    SubjectErrorMessage,
    SubjectErrorStage,
    SubjectSafeError,
    SubjectSeed,
    TrackingGap,
)


def test_normalized_box_rejects_zero_area_underflow_but_keeps_documented_minimum() -> (
    None
):
    accepted_side = math.sqrt(MIN_NORMALIZED_BOX_AREA)
    assert NormalizedBox(x=0.1, y=0.1, width=accepted_side, height=accepted_side)

    with pytest.raises(ValidationError, match="area"):
        NormalizedBox(x=0.1, y=0.1, width=5e-324, height=5e-324)


@pytest.mark.parametrize("field", ["meanMs", "medianMs", "maxAbsoluteMs"])
@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_timing_metrics_reject_nonfinite_values(field: str, value: float) -> None:
    with pytest.raises(ValidationError):
        GateTimingMetrics.model_validate(
            {"count": 1, "meanMs": 1.0, "medianMs": 1.0, "maxAbsoluteMs": 1.0}
            | {field: value}
        )


def test_timing_metrics_accept_finite_values_and_nulls() -> None:
    metrics = GateTimingMetrics.model_validate(
        {"count": 0, "meanMs": None, "medianMs": None, "maxAbsoluteMs": None}
    )
    assert metrics.mean_ms is None
    assert (
        GateTimingMetrics(
            count=1, meanMs=1.5, medianMs=-2.0, maxAbsoluteMs=2.0
        ).max_absolute_ms
        == 2.0
    )


def test_benchmark_timeline_and_frame_limits_are_finite_and_inclusive() -> None:
    recording = {
        "recordingId": "recording",
        "checksumSha256": "a" * 64,
        "byteCount": 1,
        "durationMs": MAX_BENCHMARK_TIMESTAMP_MS,
        "decodedFrameCount": MAX_BENCHMARK_FRAME_COUNT,
        "width": 1,
        "height": 1,
        "videoCodec": "h264",
        "containerFormats": ["mov"],
        "averageFrameRate": {"numerator": 30, "denominator": 1},
    }
    assert CorpusRecording.model_validate(recording).decoded_frame_count == (
        MAX_BENCHMARK_FRAME_COUNT
    )
    for field, value in (
        ("durationMs", MAX_BENCHMARK_TIMESTAMP_MS + 1),
        ("decodedFrameCount", MAX_BENCHMARK_FRAME_COUNT + 1),
    ):
        with pytest.raises(ValidationError):
            CorpusRecording.model_validate(recording | {field: value})

    assert SubjectSeed(
        timestampMs=MAX_BENCHMARK_TIMESTAMP_MS,
        frameIndex=MAX_BENCHMARK_FRAME_COUNT - 1,
        identity="subject",
        box=NormalizedBox(x=0.1, y=0.1, width=0.1, height=0.1),
    )
    with pytest.raises(ValidationError):
        SubjectSeed(
            timestampMs=MAX_BENCHMARK_TIMESTAMP_MS + 1,
            frameIndex=0,
            identity="subject",
            box=NormalizedBox(x=0.1, y=0.1, width=0.1, height=0.1),
        )
    with pytest.raises(ValidationError):
        TrackingGap(
            startTimestampMs=MAX_BENCHMARK_TIMESTAMP_MS,
            endTimestampMs=MAX_BENCHMARK_TIMESTAMP_MS + 1,
            reason="missing",
        )
    with pytest.raises(ValidationError):
        GroundTruthPass(
            passId="pass",
            cornerId="corner",
            entryTimestampMs=MAX_BENCHMARK_TIMESTAMP_MS,
            exitTimestampMs=MAX_BENCHMARK_TIMESTAMP_MS + 1,
        )


def test_benchmark_case_window_uses_finite_timestamp_limit() -> None:
    with pytest.raises(ValidationError):
        BenchmarkCase(
            caseId="case",
            recordingId="recording",
            windowStartMs=0,
            windowEndMs=MAX_BENCHMARK_TIMESTAMP_MS + 1,
            subjectSeed=SubjectSeed(
                timestampMs=0,
                frameIndex=0,
                identity="subject",
                box=NormalizedBox(x=0.1, y=0.1, width=0.1, height=0.1),
            ),
        )


@pytest.mark.parametrize(
    "value",
    [
        "/private/recording",
        r"private\\recording",
        "https://example.test",
        "www.example.test",
        "bad\nlabel",
        "bad\x7flabel",
    ],
)
def test_report_identifiers_reject_paths_urls_and_control_characters(
    value: str,
) -> None:
    with pytest.raises(ValidationError):
        TypeAdapter(SafeFreeFormIdentifier).validate_python(value)


def test_report_identifier_accepts_existing_fixture_style_labels() -> None:
    assert TypeAdapter(SafeFreeFormIdentifier).validate_python("synthetic-linear-v1")
    assert TypeAdapter(SafeFreeFormIdentifier).validate_python("subject-benchmark.v1")


def test_race_video_safe_error_keeps_legacy_words_but_rejects_urls_and_controls() -> (
    None
):
    assert (
        SafeError(
            code="INTERNAL_ERROR", stage="request", message="secret token expired"
        ).message
        == "secret token expired"
    )
    for message in ("https://example.test", "file:///tmp/error", "bad\x00message"):
        with pytest.raises(ValidationError):
            SafeError(code="INTERNAL_ERROR", stage="request", message=message)


@pytest.mark.parametrize(
    ("code", "stage", "message"),
    [
        ("INVALID_OBSERVATION", "request", "observation contract rejected"),
        ("INFERENCE_UNAVAILABLE", "initialize", "inference provider unavailable"),
        ("INFERENCE_FAILED", "track", "inference failed safely"),
        ("RESOURCE_LIMIT", "serialize", "inference resource limit exceeded"),
    ],
)
def test_subject_safe_error_accepts_only_canonical_mappings(
    code: str, stage: str, message: str
) -> None:
    assert (
        SubjectSafeError(
            code=cast("SubjectErrorCode", code),
            stage=cast("SubjectErrorStage", stage),
            message=cast("SubjectErrorMessage", message),
        ).code
        == code
    )


def test_subject_safe_error_rejects_contradictory_fields() -> None:
    with pytest.raises(ValidationError, match="canonical"):
        SubjectSafeError(
            code="INVALID_OBSERVATION",
            stage="track",
            message="inference failed safely",
        )


def test_rational_value_remains_available_for_fps_contracts() -> None:
    assert RationalValue(numerator=30, denominator=1).numerator == 30
