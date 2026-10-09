"""Contract primitives for the versioned media-service wire API."""
# ruff: noqa: EM101, TRY003

import re
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    StringConstraints,
)

CONTRACT_VERSION: Literal["race-video-validation.v1"] = "race-video-validation.v1"


SERVICE_NAME: Literal["driving-analysis-media"] = "driving-analysis-media"


UUID_V4_PATTERN = (
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


SHA256_PATTERN = r"^[0-9a-f]{64}$"


MAX_DECLARED_BYTES = 50 * 1024 * 1024 * 1024


MAX_BENCHMARK_TIMESTAMP_MS = 86_400_000


MAX_BENCHMARK_FRAME_COUNT = 10_000_000


MAX_SUBJECT_OBSERVATIONS = 100_000


MIN_REPRESENTATIVE_RECORDINGS = 3


MIN_REPRESENTATIVE_FIELD_COUNTS = 2


MIN_NORMALIZED_BOX_AREA = 1e-12


CONTROL_CHARACTER_LIMIT = 0x20


DELETE_CONTROL_CHARACTER = 0x7F


def _contains_control_character(value: str) -> bool:
    return any(
        ord(character) < CONTROL_CHARACTER_LIMIT
        or ord(character) == DELETE_CONTROL_CHARACTER
        for character in value
    )


def _safe_free_form_identifier(value: str) -> str:
    if _contains_control_character(value):
        raise ValueError("free-form identifier contains a control character")
    if "/" in value or "\\" in value:
        raise ValueError("free-form identifier contains a path separator")
    if re.search(r"(?i)(?:[a-z][a-z0-9+.-]*://|www\.)", value):
        raise ValueError("free-form identifier must not be URL-shaped")
    return value


SafeFreeFormIdentifier = Annotated[
    str,
    StringConstraints(min_length=1, max_length=128, strict=True),
    AfterValidator(_safe_free_form_identifier),
]


def _provider_identifier(value: str) -> str:
    if (
        re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,127}", value) is None
        or value.casefold() == "localhost"
    ):
        raise ValueError("provider identifier must be endpoint-free")
    return value


ProviderIdentifier = Annotated[
    str,
    StringConstraints(min_length=1, max_length=128, strict=True),
    AfterValidator(_provider_identifier),
]


def _model_identifier(value: str) -> str:
    if re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", value
    ) is None or value.endswith("."):
        raise ValueError("model identifier must be endpoint-free")
    endpoint = re.fullmatch(
        r"(?i)(?:"
        r"[a-z0-9.-]+:\d+|"
        r"\[[0-9a-f:]+\](?::\d+)?|"
        r"(?:\d{1,3}\.){3}\d{1,3}|"
        r"(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*"
        r")",
        value,
    )
    legacy_ipv4 = (
        "." in value and re.fullmatch(r"(?i)[0-9][0-9a-fx.]*", value) is not None
    )
    tagged_endpoint = False
    if value.count(":") == 1:
        prefix, tag = value.split(":", maxsplit=1)
        tagged_endpoint = (
            "." in prefix
            or prefix.casefold().rstrip(".") == "localhost"
            or re.fullmatch(r"(?:latest|[0-9][A-Za-z0-9_.-]*)", tag) is None
        )
    if (
        endpoint is not None
        or legacy_ipv4
        or tagged_endpoint
        or value.count(":") > 1
        or value.casefold().rstrip(".") == "localhost"
        or re.fullmatch(r"(?i)(?:\d+|0x[0-9a-f]+)", value) is not None
    ):
        raise ValueError("model identifier must be endpoint-free")
    return value


ModelIdentifier = Annotated[
    str,
    StringConstraints(min_length=1, max_length=128, strict=True),
    AfterValidator(_safe_free_form_identifier),
    AfterValidator(_model_identifier),
]


UuidV4String = Annotated[
    str,
    StringConstraints(
        min_length=36,
        max_length=36,
        pattern=UUID_V4_PATTERN,
        strict=True,
    ),
]


class StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


SUBJECT_CONTRACT_VERSION: Literal["subject-observation.v1"] = "subject-observation.v1"


BENCHMARK_CONTRACT_VERSION: Literal["subject-benchmark.v1"] = "subject-benchmark.v1"


REPRESENTATIVE_BENCHMARK_CONTRACT_VERSION: Literal["subject-benchmark.v2"] = (
    "subject-benchmark.v2"
)


CENTER_TOLERANCE = 1e-6
