import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from driving_analysis_service.rendering import _render_input_digest
from driving_analysis_service.rendering_contracts import (
    RenderStageAccepted,
    RenderStageRejected,
    RenderStageRequest,
)


def test_shared_typescript_render_contract_and_digest() -> None:
    root = Path(__file__).parent / "fixtures/corner-render"
    request = RenderStageRequest.model_validate_json(
        (root / "request.json").read_bytes()
    )
    accepted = RenderStageAccepted.model_validate_json(
        (root / "accepted.json").read_bytes()
    )
    assert (
        _render_input_digest(request, accepted.artifact.ffmpeg_version)
        == accepted.artifact.render_input_digest
    )


def test_shared_rejected_result_and_invalid_requests() -> None:
    root = Path(__file__).parent / "fixtures/corner-render"
    rejected = json.loads((root / "rejected.json").read_bytes())
    assert RenderStageRejected.model_validate(rejected).outcome == "rejected"
    rejected["error"]["message"] = "https://private-token"
    with pytest.raises(ValidationError):
        RenderStageRejected.model_validate(rejected)
    for case in json.loads((root / "invalid-requests.json").read_bytes()):
        with pytest.raises(ValidationError):
            RenderStageRequest.model_validate(case["request"])
