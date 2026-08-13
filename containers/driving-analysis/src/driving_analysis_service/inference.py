# Provider validation messages never cross the processing-service boundary.
# ruff: noqa: EM101, TRY003

import base64
import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from driving_analysis_service.contracts import (
    SUBJECT_CONTRACT_VERSION,
    NormalizedBox,
    StrictContract,
    SubjectProvenance,
    SubjectSeed,
)
from driving_analysis_service.settings import InferenceSettings
from driving_analysis_service.tracking_contracts import (
    PROCESSING_CONTRACT_VERSION,
    PreparedFrame,
    ProviderCandidate,
)

MAX_FIXTURE_BYTES = 1024 * 1024
MAX_FRAME_BYTES = 16 * 1024 * 1024
ALLOWED_OLLAMA_HOSTS = frozenset(
    {"127.0.0.1", "localhost", "::1", "host.docker.internal"}
)


class InferenceUnavailableError(RuntimeError):
    """The configured inference provider cannot accept work."""


class InferenceFailureError(RuntimeError):
    """The inference provider failed without exposing provider detail."""


@dataclass(frozen=True)
class InferenceFrame:
    image_path: Path
    provenance: PreparedFrame


class InferenceProvider(Protocol):
    @property
    def provenance(self) -> SubjectProvenance: ...

    def ready(self) -> bool: ...

    def infer(
        self,
        *,
        seed_frame: InferenceFrame,
        frame: InferenceFrame,
        seed: SubjectSeed,
        previous_box: NormalizedBox | None,
    ) -> ProviderCandidate: ...


def configuration_provenance(settings: InferenceSettings) -> SubjectProvenance:
    provider = settings.provider
    digest_payload = {
        "confidenceCalibration": settings.confidence_calibration,
        "identityConfidenceThreshold": settings.identity_confidence_threshold,
        "model": settings.model,
        "modelDigest": settings.model_digest,
        "modelVersion": settings.model_version,
        "pipelineVersion": PROCESSING_CONTRACT_VERSION,
        "provider": provider,
    }
    configuration_digest = hashlib.sha256(
        json.dumps(
            digest_payload,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
    ).hexdigest()
    return SubjectProvenance.model_validate(
        {**digest_payload, "configurationDigest": configuration_digest}
    )


def create_inference_provider(settings: InferenceSettings) -> InferenceProvider:
    if settings.provider == "local-http":
        return OllamaInferenceProvider.create(settings)
    if settings.provider == "fixture":
        return FixtureInferenceProvider.create(settings)
    if settings.provider == "fake":
        return FakeInferenceProvider(configuration_provenance(settings))
    return DisabledInferenceProvider()


@dataclass(frozen=True)
class DisabledInferenceProvider:
    @property
    def provenance(self) -> SubjectProvenance:
        raise InferenceUnavailableError

    def ready(self) -> bool:
        return False

    def infer(
        self,
        *,
        seed_frame: InferenceFrame,
        frame: InferenceFrame,
        seed: SubjectSeed,
        previous_box: NormalizedBox | None,
    ) -> ProviderCandidate:
        del seed_frame, frame, seed, previous_box
        raise InferenceUnavailableError


@dataclass(frozen=True)
class FakeInferenceProvider:
    _provenance: SubjectProvenance

    @property
    def provenance(self) -> SubjectProvenance:
        return self._provenance

    def ready(self) -> bool:
        return True

    def infer(
        self,
        *,
        seed_frame: InferenceFrame,
        frame: InferenceFrame,
        seed: SubjectSeed,
        previous_box: NormalizedBox | None,
    ) -> ProviderCandidate:
        del seed_frame, frame, previous_box
        return ProviderCandidate(
            box=seed.box,
            identityConfidence=1.0,
            visibility="visible",
        )


class FixtureFrame(StrictContract):
    frame_index: int = Field(alias="frameIndex", ge=0, strict=True)
    candidate: ProviderCandidate


class InferenceFixture(StrictContract):
    contract_version: str = Field(alias="contractVersion")
    frames: tuple[FixtureFrame, ...] = Field(min_length=1, strict=False)

    @model_validator(mode="after")
    def version_and_frames_are_valid(self) -> Self:
        if self.contract_version != "subject-inference-fixture.v1":
            raise ValueError("unsupported inference fixture version")
        indexes = [frame.frame_index for frame in self.frames]
        if indexes != sorted(set(indexes)):
            raise ValueError("fixture frame indexes must be ordered and unique")
        return self


@dataclass(frozen=True)
class FixtureInferenceProvider:
    _provenance: SubjectProvenance
    _candidates: dict[int, ProviderCandidate]

    @classmethod
    def create(cls, settings: InferenceSettings) -> "FixtureInferenceProvider":
        if settings.fixture_path is None:
            raise ValueError("INFERENCE_FIXTURE_PATH is required for fixture provider")
        try:
            raw = settings.fixture_path.read_bytes()
        except OSError as error:
            raise ValueError("Inference fixture could not be read") from error
        if len(raw) > MAX_FIXTURE_BYTES:
            raise ValueError("Inference fixture exceeds its size limit")
        fixture = InferenceFixture.model_validate_json(raw)
        return cls(
            configuration_provenance(settings),
            {frame.frame_index: frame.candidate for frame in fixture.frames},
        )

    @property
    def provenance(self) -> SubjectProvenance:
        return self._provenance

    def ready(self) -> bool:
        return True

    def infer(
        self,
        *,
        seed_frame: InferenceFrame,
        frame: InferenceFrame,
        seed: SubjectSeed,
        previous_box: NormalizedBox | None,
    ) -> ProviderCandidate:
        del seed_frame, seed, previous_box
        try:
            return self._candidates[frame.provenance.frame_index]
        except KeyError as error:
            raise InferenceFailureError from error


class _OllamaMessage(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True, frozen=True)
    role: str
    content: str


class _OllamaChatResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True, frozen=True)
    model: str
    message: _OllamaMessage
    done: bool


@dataclass(frozen=True)
class OllamaInferenceProvider:
    settings: InferenceSettings
    base_url: str
    _provenance: SubjectProvenance

    @classmethod
    def create(cls, settings: InferenceSettings) -> "OllamaInferenceProvider":
        base_url = _validated_ollama_url(settings.endpoint)
        return cls(settings, base_url, configuration_provenance(settings))

    @property
    def provenance(self) -> SubjectProvenance:
        return self._provenance

    def ready(self) -> bool:
        try:
            model_details = self._request(
                "/api/show",
                {"model": self.settings.model, "verbose": False},
            )
            installed_models = self._request("/api/tags", None)
        except InferenceUnavailableError:
            return False
        capabilities = model_details.get("capabilities")
        models = installed_models.get("models")
        return (
            isinstance(capabilities, list)
            and "vision" in capabilities
            and isinstance(models, list)
            and _configured_model_is_installed(models, self.settings)
        )

    def infer(
        self,
        *,
        seed_frame: InferenceFrame,
        frame: InferenceFrame,
        seed: SubjectSeed,
        previous_box: NormalizedBox | None,
    ) -> ProviderCandidate:
        seed_image = _read_frame(seed_frame.image_path)
        current_image = _read_frame(frame.image_path)
        prompt = _tracking_prompt(seed, previous_box, frame.provenance)
        response = self._request(
            "/api/chat",
            {
                "model": self.settings.model,
                "messages": [
                    {
                        "role": "user",
                        "content": prompt,
                        "images": [
                            base64.b64encode(seed_image).decode("ascii"),
                            base64.b64encode(current_image).decode("ascii"),
                        ],
                    }
                ],
                "format": ProviderCandidate.model_json_schema(by_alias=True),
                "stream": False,
                "options": {"temperature": 0},
            },
        )
        try:
            envelope = _OllamaChatResponse.model_validate(response)
        except (ValueError, TypeError) as error:
            raise InferenceFailureError from error
        if (
            envelope.model != self.settings.model
            or not envelope.done
            or envelope.message.role != "assistant"
        ):
            raise InferenceFailureError
        try:
            return ProviderCandidate.model_validate_json(envelope.message.content)
        except (ValueError, TypeError) as error:
            raise InferenceFailureError from error

    def _request(
        self,
        path: str,
        payload: dict[str, object] | None,
    ) -> dict[str, object]:
        request = urllib.request.Request(  # noqa: S310 - locally allowlisted URL
            f"{self.base_url}{path}",
            data=(
                None
                if payload is None
                else json.dumps(
                    payload,
                    allow_nan=False,
                    separators=(",", ":"),
                ).encode()
            ),
            headers={} if payload is None else {"Content-Type": "application/json"},
            method="GET" if payload is None else "POST",
        )
        try:
            with urllib.request.urlopen(  # noqa: S310 - URL is locally allowlisted
                request,
                timeout=self.settings.request_timeout_seconds,
            ) as response:
                raw = response.read(self.settings.max_response_bytes + 1)
        except (OSError, urllib.error.URLError) as error:
            raise InferenceUnavailableError from error
        if len(raw) > self.settings.max_response_bytes:
            raise InferenceFailureError
        try:
            decoded: object = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise InferenceFailureError from error
        if not isinstance(decoded, dict):
            raise InferenceFailureError
        return decoded


def _configured_model_is_installed(
    models: list[object],
    settings: InferenceSettings,
) -> bool:
    return any(
        isinstance(model, dict)
        and model.get("model", model.get("name")) == settings.model
        and model.get("digest") == settings.model_digest
        for model in models
    )


def _validated_ollama_url(value: str | None) -> str:
    endpoint = value or "http://127.0.0.1:11434"
    parsed = urllib.parse.urlsplit(endpoint)
    invalid_parts = (
        parsed.scheme != "http",
        parsed.hostname not in ALLOWED_OLLAMA_HOSTS,
        (parsed.username, parsed.password) != (None, None),
        bool(parsed.query),
        bool(parsed.fragment),
        parsed.path not in {"", "/"},
    )
    if any(invalid_parts):
        raise ValueError("Ollama endpoint must be an allowlisted local HTTP origin")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("Ollama endpoint port is invalid") from error
    if port is None:
        port = 80
    host = f"[{parsed.hostname}]" if ":" in str(parsed.hostname) else parsed.hostname
    return f"http://{host}:{port}"


def _read_frame(path: Path) -> bytes:
    raw = path.read_bytes()
    if not raw or len(raw) > MAX_FRAME_BYTES:
        raise InferenceFailureError
    return raw


def _tracking_prompt(
    seed: SubjectSeed,
    previous_box: NormalizedBox | None,
    frame: PreparedFrame,
) -> str:
    context = {
        "contractVersion": SUBJECT_CONTRACT_VERSION,
        "currentFrame": {
            "frameIndex": frame.frame_index,
            "timestampMs": frame.timestamp_ms,
        },
        "previousTrustedBox": (
            None
            if previous_box is None
            else previous_box.model_dump(mode="json", by_alias=True)
        ),
        "subjectSeed": seed.model_dump(mode="json", by_alias=True),
    }
    return (
        "Image 1 is the fixed bottom-two-thirds Track view at the Subject seed. "
        "Image 2 is the current Track-view frame. Locate only the same RC car. "
        "Return normalized coordinates relative to Image 2. Mark visibility "
        "uncertain and use a null box whenever identity is not trustworthy. "
        "Do not guess a different car. Return only the requested JSON schema.\n"
        + json.dumps(context, allow_nan=False, separators=(",", ":"), sort_keys=True)
    )
