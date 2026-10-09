"""Keep historical Python imports compatible while contracts have explicit owners."""

from driving_analysis_service import (
    benchmark_contracts,
    contract_primitives,
    contracts,
    geometry_contracts,
    media_contracts,
    observation_contracts,
)


def test_compatibility_exports_preserve_owner_identity() -> None:
    owners = (
        benchmark_contracts,
        contract_primitives,
        geometry_contracts,
        media_contracts,
        observation_contracts,
    )
    for name in contracts.__all__:
        matches = [getattr(owner, name) for owner in owners if hasattr(owner, name)]
        assert matches, name
        assert all(value is getattr(contracts, name) for value in matches), name


def test_compatibility_models_preserve_wire_aliases_and_round_trip() -> None:
    point = geometry_contracts.NormalizedPoint(x=0.25, y=0.75)
    payload = point.model_dump_json(by_alias=True)
    assert contracts.NormalizedPoint.model_validate_json(payload) == point
    response = media_contracts.HealthResponse(
        contractVersion=contract_primitives.CONTRACT_VERSION,
        service=contract_primitives.SERVICE_NAME,
        status="ready",
    )
    assert (
        contracts.HealthResponse.model_validate_json(
            response.model_dump_json(by_alias=True)
        )
        == response
    )
