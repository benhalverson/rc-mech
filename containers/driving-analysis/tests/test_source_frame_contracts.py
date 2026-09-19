import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from driving_analysis_service.api import create_app
from driving_analysis_service.settings import ServiceSettings
from driving_analysis_service.source_frames import (
    SourceFrameErrorResponse,
    SourceFrameRequest,
    SourceFrameResponse,
    frame_error,
)

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures/source-frame/contracts.json").read_text()
)


@pytest.mark.parametrize(
    "case", FIXTURES["acceptedRequests"], ids=lambda case: case["name"]
)
def test_shared_accepted_request(case: dict) -> None:
    assert (
        SourceFrameRequest.model_validate(case["value"]).model_dump(by_alias=True)
        == case["value"]
    )


@pytest.mark.parametrize(
    "case", FIXTURES["acceptedResponses"], ids=lambda case: case["name"]
)
def test_shared_accepted_response(case: dict) -> None:
    assert (
        SourceFrameResponse.model_validate(case["value"]).model_dump(by_alias=True)
        == case["value"]
    )


@pytest.mark.parametrize(
    "case", FIXTURES["invalidRequests"], ids=lambda case: case["name"]
)
def test_shared_invalid_request(case: dict, settings: ServiceSettings) -> None:
    with pytest.raises(ValidationError):
        SourceFrameRequest.model_validate(case["value"])
    response = TestClient(create_app(settings)).post(
        "/v1/frames/select", json=case["value"]
    )
    assert response.status_code == 422
    assert response.json() == FIXTURES["rejectedResponses"][0]


@pytest.mark.parametrize("value", FIXTURES["rejectedResponses"])
def test_shared_safe_error(value: dict) -> None:
    parsed = SourceFrameErrorResponse.model_validate(value)
    assert parsed.model_dump(by_alias=True) == value
    assert json.loads(frame_error(parsed.error.code, 422).body) == value


@pytest.mark.parametrize("value", FIXTURES["invalidResponses"])
def test_shared_invalid_response(value: dict) -> None:
    with pytest.raises(ValidationError):
        SourceFrameResponse.model_validate(value)


@pytest.mark.parametrize("value", FIXTURES["invalidRejectedResponses"])
def test_shared_invalid_error(value: dict) -> None:
    with pytest.raises(ValidationError):
        SourceFrameErrorResponse.model_validate(value)
