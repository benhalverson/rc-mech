import hashlib

import pytest
from pydantic import ValidationError

from chassis_notes_gpu_worker.contracts import (
    TrackingJobSubmission,
    TransferGrantCommand,
    TransferRequest,
)
from chassis_notes_gpu_worker.profile import (
    InferenceProfile,
    canonical_profile_bytes,
)
from tests.conftest import LEASE_ID, RUN_ID, SEGMENT_ID, SubmissionFactory


def test_inference_profile_uses_canonical_immutable_digest(
    profile: InferenceProfile,
) -> None:
    expected = hashlib.sha256(canonical_profile_bytes(profile)).hexdigest()

    assert profile.digest == expected
    assert profile.digest == (
        "5abae405db4372b704fe5c0984d1d8a2ed02363a52fbeac5ea09b0f7ec7a6b58"
    )
    assert canonical_profile_bytes(profile).startswith(
        b'{"canonicalizationVersion":"inference-profile-c14n.v1"'
    )
    assert b'"maximumFrameAreaRatio":"f64:4020000000000000"' in (
        canonical_profile_bytes(profile)
    )


def test_inference_profile_normalizes_negative_zero(
    profile: InferenceProfile,
) -> None:
    positive = profile.model_copy(update={"identity_confidence_threshold": 0.0})
    negative = profile.model_copy(update={"identity_confidence_threshold": -0.0})

    assert canonical_profile_bytes(negative) == canonical_profile_bytes(positive)


def test_submission_requires_the_wrapped_segment_identity(
    submission_factory: SubmissionFactory,
) -> None:
    body = submission_factory().model_dump(mode="json", by_alias=True)
    body["segmentId"] = "77777777-7777-4777-8777-777777777777"

    with pytest.raises(ValidationError):
        TrackingJobSubmission.model_validate(body)


@pytest.mark.parametrize(
    ("role", "method", "expected_method"),
    [
        ("prepared-media", "GET", "GET"),
        ("frame-manifest", "GET", "GET"),
        ("observation-artifact", "PUT", "PUT"),
        ("prepared-media", "PUT", None),
        ("observation-artifact", "GET", None),
    ],
)
def test_transfer_request_binds_role_to_method(
    role: str,
    method: str,
    expected_method: str | None,
) -> None:
    body = {
        "transferRequestId": "88888888-8888-4888-8888-888888888888",
        "role": role,
        "method": method,
    }
    if expected_method is not None:
        assert TransferRequest.model_validate(body).method == expected_method
    else:
        with pytest.raises(ValidationError):
            TransferRequest.model_validate(body)


@pytest.mark.parametrize(
    "url",
    [
        "http://r2.example/object",
        "https://user@r2.example/object",
        "https://user:secret@r2.example/object",
        "https:///object",
        "https://r2.example/object#fragment",
    ],
)
def test_transfer_grant_rejects_broad_or_unsafe_urls(
    url: str,
    submission_factory: SubmissionFactory,
) -> None:
    submission = submission_factory()
    body = {
        "contractVersion": "tracking-provider.v1",
        "runId": RUN_ID,
        "segmentId": SEGMENT_ID,
        "attemptId": submission.attempt_id,
        "leaseId": LEASE_ID,
        "fencingToken": 7,
        "specificationDigest": submission.specification_digest,
        "profileDigest": submission.profile_digest,
        "transferRequestId": "88888888-8888-4888-8888-888888888888",
        "role": "prepared-media",
        "method": "GET",
        "url": url,
        "expiresAt": 2_000_000_000,
    }

    with pytest.raises(ValidationError):
        TransferGrantCommand.model_validate(body)


def test_transfer_grant_accepts_one_https_capability(
    submission_factory: SubmissionFactory,
) -> None:
    submission = submission_factory()
    grant = TransferGrantCommand(
        contractVersion="tracking-provider.v1",
        runId=RUN_ID,
        segmentId=SEGMENT_ID,
        attemptId=submission.attempt_id,
        leaseId=LEASE_ID,
        fencingToken=7,
        specificationDigest=submission.specification_digest,
        profileDigest=submission.profile_digest,
        transferRequestId="88888888-8888-4888-8888-888888888888",
        role="prepared-media",
        method="GET",
        url="https://r2.example/object?signature=secret",
        expiresAt=2_000_000_000,
    )

    assert grant.url.endswith("signature=secret")
