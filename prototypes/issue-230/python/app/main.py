import json
from typing import Annotated, Literal

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field, StringConstraints


CONTRACT_VERSION = "issue-230.round-trip.v1"
UUID_PATTERN = (
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)


class StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class HealthResponse(StrictContract):
    ok: Literal[True]
    service: Literal["issue-230-python"]


class RoundTripRequest(StrictContract):
    contract_version: Literal[CONTRACT_VERSION] = Field(alias="contractVersion")
    correlation_id: Annotated[
        str, StringConstraints(pattern=UUID_PATTERN, strict=True)
    ] = Field(alias="correlationId")
    value: Annotated[
        str,
        StringConstraints(
            min_length=1,
            max_length=64,
            pattern=r"^[A-Za-z0-9 -]+$",
            strict=True,
        ),
    ]


class RoundTripResponse(StrictContract):
    contract_version: Literal[CONTRACT_VERSION] = Field(alias="contractVersion")
    correlation_id: Annotated[
        str, StringConstraints(pattern=UUID_PATTERN, strict=True)
    ] = Field(alias="correlationId")
    transformed_value: Annotated[
        str, StringConstraints(min_length=1, max_length=96, strict=True)
    ] = Field(alias="transformedValue")


app = FastAPI(title="Issue 230 Python Container Prototype")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(ok=True, service="issue-230-python")


@app.post("/v1/round-trip", response_model=RoundTripResponse)
def round_trip(request: RoundTripRequest) -> RoundTripResponse:
    transformed_value = f"python:{request.value.upper()}"
    print(
        json.dumps(
            {
                "event": "issue230.python.received",
                "correlationId": request.correlation_id,
                "valueLength": len(request.value),
                "transformedValueLength": len(transformed_value),
            },
            separators=(",", ":"),
        ),
        flush=True,
    )
    return RoundTripResponse(
        contractVersion=CONTRACT_VERSION,
        correlationId=request.correlation_id,
        transformedValue=transformed_value,
    )
