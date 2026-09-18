import json
from pathlib import Path

import pytest

from driving_analysis_service.tracking_contracts import SubjectObservationSegment

FIXTURE = json.loads(
    (
        Path(__file__).parent
        / "fixtures/subject-tracking/deterministic-measurement.json"
    ).read_text()
)


@pytest.mark.parametrize("scenario", FIXTURE["cases"], ids=lambda case: case["name"])
def test_shared_measurement_observations_and_gaps_round_trip(scenario: dict) -> None:
    segment = SubjectObservationSegment.model_validate(scenario["segment"])
    emitted = json.loads(segment.model_dump_json(by_alias=True))
    assert emitted == scenario["segment"]
    assert set(emitted) == {
        "contractVersion",
        "outcome",
        "caseId",
        "observations",
        "openGap",
        "provenance",
    }
