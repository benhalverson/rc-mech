import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from driving_analysis_service.inference import configuration_provenance
from driving_analysis_service.settings import InferenceSettings
from driving_analysis_service.tracking import _tracking_input_digest
from driving_analysis_service.tracking_contracts import TrackStageRequest

FIXTURES = json.loads(
    (
        Path(__file__).resolve().parent
        / "fixtures/tracking-canonical/tracking-python-canonical.json"
    ).read_text()
)


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda fixture: fixture["name"])
def test_tracking_production_bytes_and_digests_match_shared_fixture(
    fixture: dict,
) -> None:
    profile = fixture["profile"]
    settings = InferenceSettings(
        provider="sam31",
        model=profile["model"]["name"],
        model_version=profile["model"]["version"],
        model_digest=profile["model"]["digest"],
        confidence_calibration=profile["confidenceCalibration"],
        identity_confidence_threshold=profile["identityConfidenceThreshold"],
    )
    request = TrackStageRequest.model_validate(fixture["request"])
    with patch("hashlib.sha256", wraps=hashlib.sha256) as digest:
        provenance = configuration_provenance(settings)
        assert digest.call_args.args[0] == fixture["provenanceCanonical"].encode()
        assert provenance.configuration_digest == fixture["provenanceDigest"]
        result = _tracking_input_digest(request, provenance)
        assert digest.call_args.args[0] == fixture["trackingCanonical"].encode()
        assert result == fixture["trackingDigest"]
