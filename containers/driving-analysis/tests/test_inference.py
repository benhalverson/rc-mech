import json
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Literal, Self

import pytest
from pydantic import ValidationError

import driving_analysis_service.inference as inference_module
from driving_analysis_service.contracts import NormalizedBox, SubjectSeed
from driving_analysis_service.inference import (
    MAX_FIXTURE_BYTES,
    MAX_FRAME_BYTES,
    DisabledInferenceProvider,
    FakeInferenceProvider,
    FixtureInferenceProvider,
    InferenceFailureError,
    InferenceFrame,
    InferenceUnavailableError,
    OllamaInferenceProvider,
    configuration_provenance,
    create_inference_provider,
)
from driving_analysis_service.sam31_inference import Sam31InferenceProvider
from driving_analysis_service.settings import InferenceSettings
from driving_analysis_service.tracking_contracts import PreparedFrame, ProviderCandidate

MODEL_DIGEST = "4" * 64


def _settings(
    provider: Literal["disabled", "local-http", "fixture", "fake", "sam31"],
    **changes: object,
) -> InferenceSettings:
    values: dict[str, object] = {
        "provider": provider,
        "model": "llava:13b",
        "model_version": "1",
        "model_digest": MODEL_DIGEST,
        "confidence_calibration": "provider-specific-v1",
        "identity_confidence_threshold": 0.8,
    }
    values.update(changes)
    return InferenceSettings(**values)  # type: ignore[arg-type]


def _seed() -> SubjectSeed:
    return SubjectSeed.model_validate(
        {
            "timestampMs": 100,
            "frameIndex": 1,
            "identity": "subject",
            "box": {"x": 0.1, "y": 0.2, "width": 0.2, "height": 0.2},
        }
    )


def _frame(path: Path, index: int = 1) -> InferenceFrame:
    return InferenceFrame(
        path,
        PreparedFrame(
            preparedFrameIndex=index - 1,
            frameIndex=index,
            timestampMs=index * 100,
        ),
    )


def _candidate_json() -> str:
    return json.dumps(
        {
            "box": {"x": 0.2, "y": 0.2, "width": 0.2, "height": 0.2},
            "identityConfidence": 0.9,
            "visibility": "visible",
        }
    )


def test_provider_factory_and_disabled_provider(
    tmp_path: Path,
) -> None:
    fixture = tmp_path / "fixture.json"
    fixture.write_text(
        json.dumps(
            {
                "contractVersion": "subject-inference-fixture.v1",
                "frames": [
                    {
                        "frameIndex": 1,
                        "candidate": {
                            "box": {
                                "x": 0.1,
                                "y": 0.2,
                                "width": 0.2,
                                "height": 0.2,
                            },
                            "identityConfidence": 1.0,
                            "visibility": "visible",
                        },
                    }
                ],
            }
        )
    )

    ollama = create_inference_provider(_settings("local-http"))
    fixture_provider = create_inference_provider(
        _settings("fixture", fixture_path=fixture)
    )
    fake = create_inference_provider(_settings("fake"))
    sam31 = create_inference_provider(_settings("sam31"))
    disabled = create_inference_provider(_settings("disabled"))

    assert isinstance(ollama, OllamaInferenceProvider)
    assert isinstance(fixture_provider, FixtureInferenceProvider)
    assert isinstance(fake, FakeInferenceProvider)
    assert isinstance(sam31, Sam31InferenceProvider)
    assert isinstance(disabled, DisabledInferenceProvider)
    assert disabled.ready() is False
    with pytest.raises(InferenceUnavailableError):
        _ = disabled.provenance
    frame_path = tmp_path / "frame.jpg"
    frame_path.write_bytes(b"frame")
    with pytest.raises(InferenceUnavailableError):
        disabled.infer(
            seed_frame=_frame(frame_path),
            frame=_frame(frame_path),
            seed=_seed(),
            previous_box=None,
        )
    with pytest.raises(InferenceUnavailableError):
        next(
            disabled.track_segment(
                seed_frame=_frame(frame_path),
                frames=(_frame(frame_path),),
                seed=_seed(),
            )
        )


def test_fake_provider_tracks_one_stateful_segment(tmp_path: Path) -> None:
    provider = FakeInferenceProvider(configuration_provenance(_settings("fake")))
    frame_path = tmp_path / "frame.jpg"
    frame_path.write_bytes(b"frame")
    frames = (_frame(frame_path, 1), _frame(frame_path, 2))

    stream = provider.track_segment(
        seed_frame=frames[0],
        frames=frames,
        seed=_seed(),
        timeout_seconds=1.0,
    )

    assert [candidate.box for candidate in stream] == [_seed().box, _seed().box]


def test_fixture_provider_validates_files_and_missing_frames(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    no_path = _settings("fixture")
    with pytest.raises(ValueError, match="INFERENCE_FIXTURE_PATH"):
        FixtureInferenceProvider.create(no_path)

    missing = _settings("fixture", fixture_path=tmp_path / "missing.json")
    with pytest.raises(ValueError, match="could not be read"):
        FixtureInferenceProvider.create(missing)

    oversized_path = tmp_path / "large.json"
    oversized_path.write_bytes(b"x")
    monkeypatch.setattr(
        Path,
        "read_bytes",
        lambda _path: b"x" * (MAX_FIXTURE_BYTES + 1),
    )
    with pytest.raises(ValueError, match="size limit"):
        FixtureInferenceProvider.create(
            _settings("fixture", fixture_path=oversized_path)
        )


@pytest.mark.parametrize(
    "payload",
    [
        {
            "contractVersion": "wrong",
            "frames": [
                {
                    "frameIndex": 1,
                    "candidate": {
                        "box": None,
                        "identityConfidence": 0.0,
                        "visibility": "uncertain",
                    },
                }
            ],
        },
        {
            "contractVersion": "subject-inference-fixture.v1",
            "frames": [
                {
                    "frameIndex": 2,
                    "candidate": {
                        "box": None,
                        "identityConfidence": 0.0,
                        "visibility": "uncertain",
                    },
                },
                {
                    "frameIndex": 1,
                    "candidate": {
                        "box": None,
                        "identityConfidence": 0.0,
                        "visibility": "uncertain",
                    },
                },
            ],
        },
    ],
)
def test_fixture_contract_rejects_wrong_version_or_order(
    tmp_path: Path,
    payload: dict[str, object],
) -> None:
    fixture = tmp_path / "fixture.json"
    fixture.write_text(json.dumps(payload))
    with pytest.raises(ValidationError):
        FixtureInferenceProvider.create(_settings("fixture", fixture_path=fixture))


def test_fixture_provider_reports_unknown_frame(
    tmp_path: Path,
) -> None:
    fixture = tmp_path / "fixture.json"
    fixture.write_text(
        json.dumps(
            {
                "contractVersion": "subject-inference-fixture.v1",
                "frames": [
                    {
                        "frameIndex": 1,
                        "candidate": {
                            "box": None,
                            "identityConfidence": 0.0,
                            "visibility": "uncertain",
                        },
                    }
                ],
            }
        )
    )
    provider = FixtureInferenceProvider.create(
        _settings("fixture", fixture_path=fixture)
    )
    frame_path = tmp_path / "frame.jpg"
    frame_path.write_bytes(b"frame")
    assert provider.ready() is True
    assert provider.provenance.provider == "fixture"
    candidates = list(
        provider.track_segment(
            seed_frame=_frame(frame_path),
            frames=(_frame(frame_path),),
            seed=_seed(),
        )
    )
    assert len(candidates) == 1
    assert candidates[0].visibility == "uncertain"
    with pytest.raises(InferenceFailureError):
        provider.infer(
            seed_frame=_frame(frame_path),
            frame=_frame(frame_path, 2),
            seed=_seed(),
            previous_box=None,
        )


def test_ollama_tracks_a_segment_with_one_shared_deadline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = OllamaInferenceProvider.create(_settings("local-http"))
    frame_path = tmp_path / "frame.jpg"
    frame_path.write_bytes(b"frame")
    frames = (_frame(frame_path), _frame(frame_path, 2))
    previous_boxes: list[NormalizedBox | None] = []
    timeouts: list[float | None] = []

    def infer(
        _self: OllamaInferenceProvider,
        *,
        seed_frame: InferenceFrame,
        frame: InferenceFrame,
        seed: SubjectSeed,
        previous_box: NormalizedBox | None,
        timeout_seconds: float | None = None,
    ) -> ProviderCandidate:
        del seed_frame, frame, seed
        previous_boxes.append(previous_box)
        timeouts.append(timeout_seconds)
        return ProviderCandidate(
            box=_seed().box,
            identityConfidence=1.0,
            visibility="visible",
        )

    monkeypatch.setattr(OllamaInferenceProvider, "infer", infer)
    candidates = list(
        provider.track_segment(
            seed_frame=frames[0],
            frames=frames,
            seed=_seed(),
            timeout_seconds=1.0,
        )
    )

    assert len(candidates) == 2
    assert previous_boxes == [None, _seed().box]
    assert all(timeout is not None and timeout > 0 for timeout in timeouts)

    monkeypatch.setattr(
        "driving_analysis_service.inference.time.monotonic",
        lambda: 1.0,
    )
    with pytest.raises(InferenceFailureError):
        next(
            provider.track_segment(
                seed_frame=frames[0],
                frames=frames,
                seed=_seed(),
                timeout_seconds=0.0,
            )
        )


def test_ollama_readiness_covers_vision_and_connection_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = OllamaInferenceProvider.create(_settings("local-http"))
    assert provider.provenance.provider == "local-http"

    def readiness_response(
        capabilities: object,
        models: object,
    ) -> Callable[[OllamaInferenceProvider, str, object], dict[str, object]]:
        def respond(
            _self: OllamaInferenceProvider,
            path: str,
            _payload: object,
            **_kwargs: object,
        ) -> dict[str, object]:
            return (
                {"capabilities": capabilities}
                if path == "/api/show"
                else {"models": models}
            )

        return respond

    installed = [{"model": "llava:13b", "digest": MODEL_DIGEST}]
    monkeypatch.setattr(
        OllamaInferenceProvider,
        "_request",
        readiness_response(["vision"], installed),
    )
    assert provider.ready() is True
    assert provider.ready(timeout_seconds=1.0) is True

    monkeypatch.setattr(
        OllamaInferenceProvider,
        "_request",
        readiness_response(["completion"], installed),
    )
    assert provider.ready() is False
    monkeypatch.setattr(
        OllamaInferenceProvider,
        "_request",
        readiness_response("vision", installed),
    )
    assert provider.ready() is False
    monkeypatch.setattr(
        OllamaInferenceProvider,
        "_request",
        readiness_response(["vision"], "wrong"),
    )
    assert provider.ready() is False
    for models, expected in (
        (["invalid", {"model": "other", "digest": MODEL_DIGEST}], False),
        ([{"model": "llava:13b", "digest": "wrong"}], False),
        ([{"name": "llava:13b", "digest": MODEL_DIGEST}], True),
    ):
        monkeypatch.setattr(
            OllamaInferenceProvider,
            "_request",
            readiness_response(["vision"], models),
        )
        assert provider.ready() is expected

    def unavailable(
        _self: OllamaInferenceProvider,
        _path: str,
        _payload: dict[str, object],
        **_kwargs: object,
    ) -> dict[str, object]:
        raise InferenceUnavailableError

    monkeypatch.setattr(OllamaInferenceProvider, "_request", unavailable)
    assert provider.ready() is False

    def malformed(
        _self: OllamaInferenceProvider,
        _path: str,
        _payload: dict[str, object],
        **_kwargs: object,
    ) -> dict[str, object]:
        raise InferenceFailureError

    monkeypatch.setattr(OllamaInferenceProvider, "_request", malformed)
    assert provider.ready() is False


def test_ollama_inference_sends_images_schema_and_previous_box(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = OllamaInferenceProvider.create(_settings("local-http"))
    frame_path = tmp_path / "frame.jpg"
    frame_path.write_bytes(b"image")
    payloads: list[dict[str, object]] = []

    def response(
        _self: OllamaInferenceProvider,
        path: str,
        payload: dict[str, object],
        *,
        timeout_seconds: float | None = None,
    ) -> dict[str, object]:
        assert timeout_seconds is None
        assert path == "/api/chat"
        payloads.append(payload)
        return {
            "model": "llava:13b",
            "message": {"role": "assistant", "content": _candidate_json()},
            "done": True,
        }

    monkeypatch.setattr(OllamaInferenceProvider, "_request", response)
    previous = NormalizedBox(x=0.1, y=0.2, width=0.2, height=0.2)
    candidate = provider.infer(
        seed_frame=_frame(frame_path),
        frame=_frame(frame_path, 2),
        seed=_seed(),
        previous_box=previous,
    )
    assert candidate.identity_confidence == 0.9
    message = payloads[0]["messages"]
    assert isinstance(message, list)
    content = message[0]["content"]
    assert isinstance(content, str)
    assert '"previousTrustedBox":{"height":0.2' in content
    assert payloads[0]["stream"] is False
    assert isinstance(payloads[0]["format"], dict)

    provider.infer(
        seed_frame=_frame(frame_path),
        frame=_frame(frame_path),
        seed=_seed(),
        previous_box=None,
    )
    second_message = payloads[1]["messages"]
    assert isinstance(second_message, list)
    assert '"previousTrustedBox":null' in second_message[0]["content"]


@pytest.mark.parametrize(
    ("response", "expected_error"),
    [
        ({}, InferenceFailureError),
        (
            {
                "model": "wrong",
                "message": {"role": "assistant", "content": _candidate_json()},
                "done": True,
            },
            InferenceFailureError,
        ),
        (
            {
                "model": "llava:13b",
                "message": {"role": "assistant", "content": _candidate_json()},
                "done": False,
            },
            InferenceFailureError,
        ),
        (
            {
                "model": "llava:13b",
                "message": {"role": "user", "content": _candidate_json()},
                "done": True,
            },
            InferenceFailureError,
        ),
        (
            {
                "model": "llava:13b",
                "message": {"role": "assistant", "content": "{}"},
                "done": True,
            },
            InferenceFailureError,
        ),
    ],
)
def test_ollama_inference_rejects_invalid_envelopes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    response: dict[str, object],
    expected_error: type[Exception],
) -> None:
    provider = OllamaInferenceProvider.create(_settings("local-http"))
    frame_path = tmp_path / "frame.jpg"
    frame_path.write_bytes(b"image")
    monkeypatch.setattr(
        OllamaInferenceProvider,
        "_request",
        lambda _self, _path, _payload, **_kwargs: response,
    )
    with pytest.raises(expected_error):
        provider.infer(
            seed_frame=_frame(frame_path),
            frame=_frame(frame_path),
            seed=_seed(),
            previous_box=None,
        )


class _Response:
    def __init__(self, value: bytes, url: str) -> None:
        self.value = value
        self.url = url

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        _exception_type: type[BaseException] | None,
        _exception: BaseException | None,
        _traceback: object,
    ) -> None:
        return None

    def read(self, _size: int) -> bytes:
        return self.value

    def geturl(self) -> str:
        return self.url


def test_local_http_opener_disables_proxies_and_redirects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handlers: tuple[object, ...] = ()
    response = _Response(b"{}", "http://localhost:11434/api/show")

    class Opener:
        def open(self, request: urllib.request.Request, *, timeout: float) -> _Response:
            assert request.full_url == "http://localhost:11434/api/show"
            assert timeout == 1.0
            return response

    def build_opener(*values: object) -> Opener:
        nonlocal handlers
        handlers = values
        return Opener()

    monkeypatch.setattr(urllib.request, "build_opener", build_opener)
    request = urllib.request.Request("http://localhost:11434/api/show")
    assert inference_module._open_local_http(request, timeout=1.0) is response
    proxy_handler, redirect_handler = handlers
    assert isinstance(proxy_handler, urllib.request.ProxyHandler)
    assert vars(proxy_handler)["proxies"] == {}
    assert isinstance(redirect_handler, inference_module._RejectRedirects)
    redirect_handler.redirect_request(request, None, 302, "redirect", {}, "/else")


@pytest.mark.parametrize(
    ("raw", "expected_error"),
    [
        (json.dumps({"ok": True}).encode(), None),
        (b"x" * 65_537, InferenceFailureError),
        (b"not-json", InferenceFailureError),
        (b"\xff", InferenceFailureError),
        (b"[]", InferenceFailureError),
    ],
)
def test_ollama_request_bounds_and_validates_json(
    monkeypatch: pytest.MonkeyPatch,
    raw: bytes,
    expected_error: type[Exception] | None,
) -> None:
    provider = OllamaInferenceProvider.create(_settings("local-http"))

    def respond(
        _request: urllib.request.Request,
        *,
        timeout: float,
    ) -> _Response:
        assert timeout in {1.0, 30.0}
        assert _request.get_method() in {"GET", "POST"}
        return _Response(raw, _request.full_url)

    monkeypatch.setattr(
        inference_module,
        "_open_local_http",
        respond,
    )
    if expected_error is None:
        assert provider._request("/api/show", {}) == {"ok": True}
        assert provider._request("/api/tags", None) == {"ok": True}
        assert provider._request("/api/show", {}, timeout_seconds=1.0) == {"ok": True}
    else:
        with pytest.raises(expected_error):
            provider._request("/api/show", {})


def test_ollama_request_maps_connection_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = OllamaInferenceProvider.create(_settings("local-http"))

    def fail(
        _request: urllib.request.Request,
        timeout: float,
    ) -> _Response:
        del timeout
        msg = "private provider detail"
        raise urllib.error.URLError(msg)

    monkeypatch.setattr(inference_module, "_open_local_http", fail)
    with pytest.raises(InferenceUnavailableError):
        provider._request("/api/show", {})


def test_ollama_request_rejects_a_changed_response_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = OllamaInferenceProvider.create(_settings("local-http"))
    monkeypatch.setattr(
        inference_module,
        "_open_local_http",
        lambda *_args, **_kwargs: _Response(b"{}", "http://example.com/redirect"),
    )
    with pytest.raises(InferenceUnavailableError):
        provider._request("/api/show", {})


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://localhost:11434",
        "http://example.com:11434",
        "http://user:pass@localhost:11434",
        "http://localhost:11434?query=yes",
        "http://localhost:11434#fragment",
        "http://localhost:11434/api",
    ],
)
def test_ollama_endpoint_rejects_nonlocal_origins(endpoint: str) -> None:
    with pytest.raises(ValueError, match="local HTTP origin"):
        OllamaInferenceProvider.create(_settings("local-http", endpoint=endpoint))


def test_ollama_endpoint_normalizes_default_and_ipv6_ports() -> None:
    default = OllamaInferenceProvider.create(_settings("local-http", endpoint=None))
    no_port = OllamaInferenceProvider.create(
        _settings("local-http", endpoint="http://localhost")
    )
    ipv6 = OllamaInferenceProvider.create(
        _settings("local-http", endpoint="http://[::1]:11434/")
    )
    assert default.base_url == "http://127.0.0.1:11434"
    assert no_port.base_url == "http://localhost:80"
    assert ipv6.base_url == "http://[::1]:11434"
    with pytest.raises(ValueError, match="port is invalid"):
        OllamaInferenceProvider.create(
            _settings("local-http", endpoint="http://localhost:invalid")
        )


@pytest.mark.parametrize("frame_bytes", [b"", b"x" * (MAX_FRAME_BYTES + 1)])
def test_ollama_rejects_empty_or_oversized_frames(
    tmp_path: Path,
    frame_bytes: bytes,
) -> None:
    provider = OllamaInferenceProvider.create(_settings("local-http"))
    frame_path = tmp_path / "frame.jpg"
    frame_path.write_bytes(frame_bytes)
    with pytest.raises(InferenceFailureError):
        provider.infer(
            seed_frame=_frame(frame_path),
            frame=_frame(frame_path),
            seed=_seed(),
            previous_box=None,
        )


def test_configuration_digest_changes_with_provider_configuration() -> None:
    first = configuration_provenance(_settings("fake"))
    second = configuration_provenance(
        replace(_settings("fake"), identity_confidence_threshold=0.9)
    )
    assert first.configuration_digest != second.configuration_digest
