import hashlib
from collections.abc import Callable
from pathlib import Path

import pytest
from driving_analysis_service.tracking_contracts import ObservationSegmentArtifact

from chassis_notes_gpu_worker.contracts import (
    OutputArtifact,
    TrackingJobSubmission,
)
from chassis_notes_gpu_worker.profile import InferenceProfile
from chassis_notes_gpu_worker.settings import WorkerSettings

RUN_ID = "11111111-1111-4111-8111-111111111111"
SEGMENT_ID = "22222222-2222-4222-8222-222222222222"
ATTEMPT_ID = "33333333-3333-4333-8333-333333333333"
LEASE_ID = "44444444-4444-4444-8444-444444444444"
PREPARED_ID = "55555555-5555-4555-8555-555555555555"
CORRELATION_ID = "66666666-6666-4666-8666-666666666666"
MEDIA_BYTES = b"prepared-media"
MANIFEST_BYTES = b"frame-manifest"
OUTPUT_BYTES = b"observation-artifact"

SubmissionFactory = Callable[..., TrackingJobSubmission]
ArtifactFactory = Callable[[TrackingJobSubmission], OutputArtifact]


@pytest.fixture
def profile() -> InferenceProfile:
    return InferenceProfile.model_validate(
        {
            "contractVersion": "inference-profile.v1",
            "canonicalizationVersion": "inference-profile-c14n.v1",
            "provider": "local-sam31",
            "model": {
                "name": "sam3.1",
                "version": "96914d2425f90a64f45ca977c2b5165418099543",
                "digest": "1" * 64,
            },
            "pipeline": {"version": "subject-tracking.v1", "digest": "2" * 64},
            "runtimeImageDigest": "3" * 64,
            "preprocessing": "fixed-track-view-frames.v1",
            "precision": "float32",
            "confidenceCalibration": "sam31-point-mask-v1",
            "identityConfidenceThreshold": 0.3,
            "promptSemantics": "subject-box-center-positive-point.v1",
            "tracking": {
                "minimumAreaRatio": 0.05,
                "maximumSeedAreaRatio": 25.0,
                "maximumFrameAreaRatio": 8.0,
                "maximumCenterDisplacement": 0.35,
            },
        }
    )


@pytest.fixture
def worker_settings(tmp_path: Path, profile: InferenceProfile) -> WorkerSettings:
    return WorkerSettings(
        state_root=tmp_path / "state",
        checkpoint_path=tmp_path / "sam3.1.pt",
        installed_profile=profile,
        watchdog_seconds=10,
        transfer_timeout_seconds=5,
        max_input_bytes=1024,
        max_output_bytes=1024,
    )


@pytest.fixture
def submission_factory(profile: InferenceProfile) -> SubmissionFactory:
    def create(**changes: object) -> TrackingJobSubmission:
        values: dict[str, object] = {
            "contractVersion": "tracking-provider.v1",
            "runId": RUN_ID,
            "segmentId": SEGMENT_ID,
            "attemptId": ATTEMPT_ID,
            "leaseId": LEASE_ID,
            "fencingToken": 7,
            "specificationDigest": "4" * 64,
            "profileDigest": profile.digest,
            "trackingRequest": {
                "contractVersion": "subject-tracking.v1",
                "correlationId": CORRELATION_ID,
                "caseId": "fixture-race",
                "observationSegmentId": SEGMENT_ID,
                "prepared": {
                    "preparedMediaId": PREPARED_ID,
                    "caseId": "fixture-race",
                    "byteCount": len(MEDIA_BYTES),
                    "checksumSha256": hashlib.sha256(MEDIA_BYTES).hexdigest(),
                    "frameManifestByteCount": len(MANIFEST_BYTES),
                    "frameManifestChecksumSha256": hashlib.sha256(
                        MANIFEST_BYTES
                    ).hexdigest(),
                    "sourceByteCount": 100,
                    "sourceChecksumSha256": "5" * 64,
                    "window": {"startTimestampMs": 100, "endTimestampMs": 400},
                    "trackView": {
                        "x": 0.0,
                        "y": 1 / 3,
                        "width": 1.0,
                        "height": 2 / 3,
                    },
                    "width": 160,
                    "height": 60,
                    "decodedFrameCount": 3,
                    "averageFrameRate": {"numerator": 10, "denominator": 1},
                    "ffmpegVersion": "7.1.2",
                    "pipelineVersion": "subject-tracking.v1",
                    "preparationInputDigest": "6" * 64,
                    "preparationConfigurationDigest": "7" * 64,
                },
                "subjectSeed": {
                    "timestampMs": 100,
                    "frameIndex": 1,
                    "identity": "subject",
                    "box": {"x": 0.1, "y": 0.2, "width": 0.2, "height": 0.2},
                },
            },
        }
        values.update(changes)
        return TrackingJobSubmission.model_validate(values)

    return create


@pytest.fixture
def artifact_factory() -> ArtifactFactory:
    def create(submission: TrackingJobSubmission) -> OutputArtifact:
        segment = ObservationSegmentArtifact.model_validate(
            {
                "observationSegmentId": submission.segment_id,
                "caseId": submission.tracking_request.case_id,
                "byteCount": len(OUTPUT_BYTES),
                "checksumSha256": hashlib.sha256(OUTPUT_BYTES).hexdigest(),
                "contentEncoding": "gzip",
                "mediaType": "application/vnd.rc-mech.subject-observations+json",
                "observationCount": 1,
                "completed": True,
                "gap": None,
                "provenance": {
                    "provider": "sam31",
                    "model": "sam3.1",
                    "modelVersion": "96914d2425f90a64f45ca977c2b5165418099543",
                    "pipelineVersion": "subject-tracking.v1",
                    "configurationDigest": "8" * 64,
                    "modelDigest": "1" * 64,
                    "identityConfidenceThreshold": 0.3,
                    "confidenceCalibration": "sam31-point-mask-v1",
                },
                "ffmpegVersion": "7.1.2",
                "sourceChecksumSha256": "5" * 64,
                "preparedChecksumSha256": (
                    submission.tracking_request.prepared.checksum_sha256
                ),
                "preparationConfigurationDigest": "7" * 64,
                "trackingInputDigest": "9" * 64,
            }
        )
        return OutputArtifact(
            contractVersion="tracking-artifact.v1",
            runId=submission.run_id,
            segmentId=submission.segment_id,
            attemptId=submission.attempt_id,
            leaseId=submission.lease_id,
            fencingToken=submission.fencing_token,
            specificationDigest=submission.specification_digest,
            profileDigest=submission.profile_digest,
            segment=segment,
        )

    return create
