import gzip
import hashlib
import json
from collections.abc import Generator
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

from fastapi.testclient import TestClient

from driving_analysis_service.api import create_app
from driving_analysis_service.contracts import SubjectProvenance, SubjectSeed
from driving_analysis_service.inference import (
    FakeInferenceProvider,
    FixtureInferenceProvider,
    InferenceFrame,
    configuration_provenance,
)
from driving_analysis_service.preparation import RaceWindowPreparationService
from driving_analysis_service.settings import InferenceSettings, ServiceSettings
from driving_analysis_service.tracking import SubjectTrackingService
from driving_analysis_service.tracking_artifacts import (
    OBSERVATION_BUNDLE_SUFFIX,
    OBSERVATION_SEGMENT_SUFFIX,
    bundle_member_path,
)
from driving_analysis_service.tracking_contracts import (
    PrepareStageAccepted,
    PrepareStageRequest,
    ProcessingRejected,
    ProviderCandidate,
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


@dataclass(frozen=True)
class _SegmentOnlyProvider:
    _provenance: SubjectProvenance

    @property
    def provenance(self) -> SubjectProvenance:
        return self._provenance

    def ready(self, *, timeout_seconds: float | None = None) -> bool:
        del timeout_seconds
        return True

    def track_segment(
        self,
        *,
        seed_frame: InferenceFrame,
        frames: tuple[InferenceFrame, ...],
        seed: SubjectSeed,
        timeout_seconds: float | None = None,
    ) -> Generator[ProviderCandidate]:
        del seed_frame, timeout_seconds
        for _frame in frames:
            yield ProviderCandidate(
                box=seed.box,
                identityConfidence=1.0,
                visibility="visible",
            )


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

    duplicate_prepare = RaceWindowPreparationService(configured).prepare(
        _prepare_request(byte_count)
    )
    assert isinstance(duplicate_prepare, PrepareStageAccepted)
    assert duplicate_prepare.prepared == prepared.prepared

    with TestClient(create_app(configured)) as client:
        removed_track_response = client.post(
            "/v1/stages/track",
            json=_track_request(prepared).model_dump(mode="json", by_alias=True),
        )

    assert removed_track_response.status_code == 404
    tracked = SubjectTrackingService(
        configured,
        FakeInferenceProvider(configuration_provenance(configured.inference)),
    ).track(_track_request(prepared))
    assert isinstance(tracked, TrackStageAccepted)
    assert tracked.segment.completed is True
    assert tracked.segment.gap is None
    assert tracked.segment.observation_count == 3
    assert tracked.segment.content_encoding == "gzip"
    assert tracked.segment.provenance.provider == "fake"
    assert tracked.segment.provenance.identity_confidence_threshold == 0.8
    segment_path = bundle_member_path(
        configured,
        SEGMENT_ID,
        OBSERVATION_BUNDLE_SUFFIX,
        OBSERVATION_SEGMENT_SUFFIX,
    )
    raw_segment = segment_path.read_bytes()
    assert hashlib.sha256(raw_segment).hexdigest() == tracked.segment.checksum_sha256
    envelope = json.loads(gzip.decompress(raw_segment))
    assert [item["timestampMs"] for item in envelope["observations"]] == [100, 200, 300]
    assert [item["frameIndex"] for item in envelope["observations"]] == [1, 2, 3]
    assert envelope["openGap"] is None

    duplicate = SubjectTrackingService(
        configured,
        FakeInferenceProvider(tracked.segment.provenance),
    ).track(_track_request(prepared))
    assert isinstance(duplicate, TrackStageAccepted)
    assert duplicate.segment == tracked.segment

    changed_prepared = prepared.prepared.model_copy(
        update={"checksum_sha256": "0" * 64}
    )
    changed_request = _track_request(prepared).model_copy(
        update={"prepared": changed_prepared}
    )
    conflict = SubjectTrackingService(
        configured,
        FakeInferenceProvider(tracked.segment.provenance),
    ).track(changed_request)
    assert isinstance(conflict, ProcessingRejected)
    assert conflict.error.code == "ARTIFACT_CONFLICT"

    segment_path.write_bytes(b"tampered")
    tampered = SubjectTrackingService(
        configured,
        FakeInferenceProvider(tracked.segment.provenance),
    ).track(_track_request(prepared))
    assert isinstance(tampered, ProcessingRejected)
    assert tampered.error.code == "MEDIA_UNAVAILABLE"


def test_tracking_stage_consumes_one_provider_segment(
    settings: ServiceSettings,
    accepted_video: Path,
) -> None:
    configured = replace(settings, inference=_inference_settings())
    prepared = RaceWindowPreparationService(configured).prepare(
        _prepare_request(stage_media(configured, accepted_video))
    )
    assert isinstance(prepared, PrepareStageAccepted)
    provenance = configuration_provenance(configured.inference)

    result = SubjectTrackingService(
        configured,
        _SegmentOnlyProvider(provenance),
    ).track(_track_request(prepared))

    assert isinstance(result, TrackStageAccepted)
    assert result.segment.observation_count == 3


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
    raw = bundle_member_path(
        configured,
        SEGMENT_ID,
        OBSERVATION_BUNDLE_SUFFIX,
        OBSERVATION_SEGMENT_SUFFIX,
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
