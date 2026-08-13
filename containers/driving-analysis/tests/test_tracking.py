import gzip
import hashlib
import json
from dataclasses import replace
from pathlib import Path
from typing import Literal

from fastapi.testclient import TestClient

from driving_analysis_service.api import create_app
from driving_analysis_service.inference import (
    FakeInferenceProvider,
    FixtureInferenceProvider,
)
from driving_analysis_service.settings import InferenceSettings, ServiceSettings
from driving_analysis_service.tracking import (
    OBSERVATION_SEGMENT_SUFFIX,
    RaceWindowPreparationService,
    SubjectTrackingService,
)
from driving_analysis_service.tracking_contracts import (
    PrepareStageAccepted,
    PrepareStageRequest,
    ProcessingRejected,
    TrackStageAccepted,
    TrackStageRequest,
)
from tests.conftest import (
    CORRELATION_ID,
    STAGED_MEDIA_ID,
    stage_media,
)

PREPARED_MEDIA_ID = "bde7ec63-86b9-4c86-a5e8-dbcf4a61f820"
SEGMENT_ID = "edb9d9c2-1ca8-48c3-ae7d-69222aab25f2"
MODEL_DIGEST = "4" * 64


def _inference_settings(
    provider: Literal["fake", "fixture"] = "fake",
    *,
    fixture_path: Path | None = None,
) -> InferenceSettings:
    return InferenceSettings(
        provider=provider,
        model="fixture",
        model_version="1",
        model_digest=MODEL_DIGEST,
        confidence_calibration="fixture-linear-v1",
        identity_confidence_threshold=0.8,
        fixture_path=fixture_path,
    )


def _prepare_request(byte_count: int) -> PrepareStageRequest:
    return PrepareStageRequest.model_validate(
        {
            "contractVersion": "subject-tracking.v1",
            "correlationId": CORRELATION_ID,
            "caseId": "fixture-race",
            "preparedMediaId": PREPARED_MEDIA_ID,
            "input": {
                "stagedMediaId": STAGED_MEDIA_ID,
                "expectedByteCount": byte_count,
            },
            "window": {"startTimestampMs": 100, "endTimestampMs": 400},
            "pipelineVersion": "subject-tracking.v1",
        }
    )


def _track_request(prepared: PrepareStageAccepted) -> TrackStageRequest:
    first_timestamp = 100
    first_frame = 1
    return TrackStageRequest.model_validate(
        {
            "contractVersion": "subject-tracking.v1",
            "correlationId": CORRELATION_ID,
            "caseId": "fixture-race",
            "observationSegmentId": SEGMENT_ID,
            "prepared": prepared.prepared.model_dump(mode="json", by_alias=True),
            "subjectSeed": {
                "timestampMs": first_timestamp,
                "frameIndex": first_frame,
                "identity": "subject",
                "box": {"x": 0.1, "y": 0.2, "width": 0.2, "height": 0.2},
            },
        }
    )


def test_real_ffmpeg_prepare_and_fake_track_are_immutable(
    settings: ServiceSettings,
    accepted_video: Path,
) -> None:
    configured = replace(settings, inference=_inference_settings())
    byte_count = stage_media(configured, accepted_video)

    with TestClient(create_app(configured)) as client:
        prepare_response = client.post(
            "/v1/stages/prepare",
            json=_prepare_request(byte_count).model_dump(mode="json", by_alias=True),
        )

    assert prepare_response.status_code == 200
    prepared = PrepareStageAccepted.model_validate(prepare_response.json())
    assert prepared.prepared.window.start_timestamp_ms == 100
    assert prepared.prepared.window.end_timestamp_ms == 400
    assert prepared.prepared.track_view.model_dump() == {
        "x": 0.0,
        "y": 1 / 3,
        "width": 1.0,
        "height": 2 / 3,
    }
    assert (prepared.prepared.width, prepared.prepared.height) == (160, 60)
    assert prepared.prepared.decoded_frame_count == 3
    assert prepared.prepared.source_byte_count == byte_count
    assert prepared.prepared.pipeline_version == "subject-tracking.v1"
    assert list(configured.staging_root.iterdir()) == []

    with TestClient(create_app(configured)) as client:
        track_response = client.post(
            "/v1/stages/track",
            json=_track_request(prepared).model_dump(mode="json", by_alias=True),
        )

    assert track_response.status_code == 200
    tracked = TrackStageAccepted.model_validate(track_response.json())
    assert tracked.segment.completed is True
    assert tracked.segment.gap is None
    assert tracked.segment.observation_count == 3
    assert tracked.segment.content_encoding == "gzip"
    assert tracked.segment.provenance.provider == "fake"
    assert tracked.segment.provenance.identity_confidence_threshold == 0.8
    segment_path = (
        configured.artifact_root / f"{SEGMENT_ID}{OBSERVATION_SEGMENT_SUFFIX}"
    )
    raw_segment = segment_path.read_bytes()
    assert hashlib.sha256(raw_segment).hexdigest() == tracked.segment.checksum_sha256
    envelope = json.loads(gzip.decompress(raw_segment))
    assert [item["timestampMs"] for item in envelope["observations"]] == [100, 200, 300]
    assert [item["frameIndex"] for item in envelope["observations"]] == [1, 2, 3]
    assert envelope["gaps"] == []

    duplicate = SubjectTrackingService(
        configured,
        FakeInferenceProvider(tracked.segment.provenance),
    ).track(_track_request(prepared))
    assert isinstance(duplicate, ProcessingRejected)
    assert duplicate.error.code == "ARTIFACT_CONFLICT"


def test_fixture_provider_stops_at_first_untrusted_frame(
    settings: ServiceSettings,
    accepted_video: Path,
) -> None:
    fixture_path = (
        Path(__file__).parent
        / "fixtures"
        / "subject-tracking"
        / "trusted-provider.json"
    )
    configured = replace(
        settings,
        inference=_inference_settings("fixture", fixture_path=fixture_path),
    )
    prepared = RaceWindowPreparationService(configured).prepare(
        _prepare_request(stage_media(configured, accepted_video))
    )
    assert isinstance(prepared, PrepareStageAccepted)

    result = SubjectTrackingService(
        configured,
        FixtureInferenceProvider.create(configured.inference),
    ).track(_track_request(prepared))

    assert isinstance(result, TrackStageAccepted)
    assert result.segment.completed is False
    assert result.segment.observation_count == 2
    assert result.segment.gap is not None
    assert result.segment.gap.start_timestamp_ms == 300
    assert result.segment.gap.end_timestamp_ms == 400
    raw = (
        configured.artifact_root / f"{SEGMENT_ID}{OBSERVATION_SEGMENT_SUFFIX}"
    ).read_bytes()
    observations = json.loads(gzip.decompress(raw))["observations"]
    assert [item["frameIndex"] for item in observations] == [1, 2]


def test_stage_validation_errors_use_processing_contract(
    settings: ServiceSettings,
) -> None:
    with TestClient(create_app(settings)) as client:
        stage_response = client.post("/v1/stages/prepare", json={})
        media_response = client.post("/v1/media/probe", json={})

    assert stage_response.status_code == 422
    assert stage_response.json() == {
        "contractVersion": "subject-tracking.v1",
        "correlationId": None,
        "outcome": "rejected",
        "caseId": None,
        "error": {
            "code": "INVALID_REQUEST",
            "stage": "request",
            "message": "processing request rejected",
        },
    }
    assert media_response.json()["contractVersion"] == "race-video-validation.v1"
