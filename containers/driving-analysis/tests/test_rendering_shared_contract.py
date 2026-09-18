from pathlib import Path

from driving_analysis_service.rendering import _render_input_digest
from driving_analysis_service.rendering_contracts import (
    RenderStageAccepted,
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
