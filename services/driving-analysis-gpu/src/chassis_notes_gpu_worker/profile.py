import hashlib
import json
import struct
from typing import Annotated, Literal

from driving_analysis_service.contracts import SHA256_PATTERN, StrictContract
from pydantic import Field, StringConstraints

Sha256 = Annotated[str, StringConstraints(pattern=SHA256_PATTERN, strict=True)]


class ModelIdentity(StrictContract):
    name: Literal["sam3.1"]
    version: str = Field(min_length=1, max_length=128)
    digest: Sha256


class PipelineIdentity(StrictContract):
    version: str = Field(min_length=1, max_length=128)
    digest: Sha256


class TrackingConfiguration(StrictContract):
    minimum_area_ratio: float = Field(alias="minimumAreaRatio", gt=0, strict=True)
    maximum_seed_area_ratio: float = Field(
        alias="maximumSeedAreaRatio", gt=0, strict=True
    )
    maximum_frame_area_ratio: float = Field(
        alias="maximumFrameAreaRatio", gt=0, strict=True
    )
    maximum_center_displacement: float = Field(
        alias="maximumCenterDisplacement", gt=0, le=1, strict=True
    )


class InferenceProfile(StrictContract):
    contract_version: Literal["inference-profile.v1"] = Field(alias="contractVersion")
    canonicalization_version: Literal["inference-profile-c14n.v1"] = Field(
        alias="canonicalizationVersion"
    )
    provider: Literal["local-sam31"]
    model: ModelIdentity
    pipeline: PipelineIdentity
    runtime_image_digest: Sha256 = Field(alias="runtimeImageDigest")
    preprocessing: Literal["fixed-track-view-frames.v1"]
    precision: Literal["float32", "float16", "bfloat16"]
    confidence_calibration: str = Field(
        alias="confidenceCalibration", min_length=1, max_length=128
    )
    identity_confidence_threshold: float = Field(
        alias="identityConfidenceThreshold", ge=0, le=1, strict=True
    )
    prompt_semantics: Literal["subject-box-center-positive-point.v1"] = Field(
        alias="promptSemantics"
    )
    tracking: TrackingConfiguration

    @property
    def digest(self) -> str:
        return hashlib.sha256(canonical_profile_bytes(self)).hexdigest()


def canonical_profile_bytes(profile: InferenceProfile) -> bytes:
    tracking = profile.tracking
    payload = {
        "canonicalizationVersion": profile.canonicalization_version,
        "confidenceCalibration": profile.confidence_calibration,
        "contractVersion": profile.contract_version,
        "identityConfidenceThreshold": _float64_token(
            profile.identity_confidence_threshold
        ),
        "model": profile.model.model_dump(mode="json"),
        "pipeline": profile.pipeline.model_dump(mode="json"),
        "precision": profile.precision,
        "preprocessing": profile.preprocessing,
        "promptSemantics": profile.prompt_semantics,
        "provider": profile.provider,
        "runtimeImageDigest": profile.runtime_image_digest,
        "tracking": {
            "maximumCenterDisplacement": _float64_token(
                tracking.maximum_center_displacement
            ),
            "maximumFrameAreaRatio": _float64_token(tracking.maximum_frame_area_ratio),
            "maximumSeedAreaRatio": _float64_token(tracking.maximum_seed_area_ratio),
            "minimumAreaRatio": _float64_token(tracking.minimum_area_ratio),
        },
    }
    return json.dumps(
        payload,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()


def _float64_token(value: float) -> str:
    normalized = 0.0 if value == 0 else value
    return f"f64:{struct.pack('>d', normalized).hex()}"
