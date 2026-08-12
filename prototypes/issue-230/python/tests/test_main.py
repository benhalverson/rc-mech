from fastapi.testclient import TestClient
import pytest

from app.main import app


client = TestClient(app)


def test_health_reports_python_service_readiness() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "issue-230-python"}


def test_round_trip_returns_the_worker_correlation_id_and_python_value() -> None:
    response = client.post(
        "/v1/round-trip",
        json={
            "contractVersion": "issue-230.round-trip.v1",
            "correlationId": "c3d1ea64-7c62-4a1e-a41f-43fe101b7f41",
            "value": "trackside",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "contractVersion": "issue-230.round-trip.v1",
        "correlationId": "c3d1ea64-7c62-4a1e-a41f-43fe101b7f41",
        "transformedValue": "python:TRACKSIDE",
    }


@pytest.mark.parametrize(
    "body",
    [
        {
            "contractVersion": "issue-230.round-trip.v2",
            "correlationId": "c3d1ea64-7c62-4a1e-a41f-43fe101b7f41",
            "value": "trackside",
        },
        {
            "contractVersion": "issue-230.round-trip.v1",
            "correlationId": "not-a-correlation-id",
            "value": "trackside",
        },
        {
            "contractVersion": "issue-230.round-trip.v1",
            "correlationId": "c3d1ea64-7c62-4a1e-a41f-43fe101b7f41",
            "value": 230,
        },
        {
            "contractVersion": "issue-230.round-trip.v1",
            "correlationId": "c3d1ea64-7c62-4a1e-a41f-43fe101b7f41",
            "value": "",
        },
        {
            "contractVersion": "issue-230.round-trip.v1",
            "correlationId": "c3d1ea64-7c62-4a1e-a41f-43fe101b7f41",
            "value": "x" * 65,
        },
        {
            "contractVersion": "issue-230.round-trip.v1",
            "correlationId": "c3d1ea64-7c62-4a1e-a41f-43fe101b7f41",
            "value": "trackside",
            "extra": True,
        },
    ],
)
def test_round_trip_rejects_values_outside_the_strict_contract(
    body: dict[str, object],
) -> None:
    response = client.post("/v1/round-trip", json=body)

    assert response.status_code == 422
