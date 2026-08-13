# Driving-analysis Python processing service

This internal FastAPI service validates staged Race recordings, prepares bounded Track-view media, and emits provider-neutral Subject observations. It does not accept URLs, R2 keys, credentials, public upload metadata, or application identity. Python does not define Track maps, measure Corner gates, rank passes, write Garage history, or decide application lifecycle state.

The caller stages the recording as `<stagedMediaId>.media` beneath `RC_MECH_MEDIA_STAGING_ROOT` (default `/var/lib/rc-mech/staged`) and supplies only the opaque UUID plus the expected byte count. Probe and prepare requests consume that temporary staged file. Request work is isolated beneath `RC_MECH_MEDIA_WORK_ROOT` (default `/tmp/rc-mech-media`) and removed after every accepted or rejected result. Immutable prepared media, provenance manifests, and gzip observation segments are written beneath `RC_MECH_ANALYSIS_ARTIFACT_ROOT` (default `/var/lib/rc-mech/artifacts`); later Worker integration mediates durable private R2 storage.

## Quality gate

Install `uv`, then run the complete hermetic Python gate from this directory:

```console
uv run --frozen python -m driving_analysis_service.quality
```

The command checks formatting, lint, strict static analysis, tests, and branch coverage. The tests use only local synthetic fixtures and the host's `/usr/bin/ffprobe` and `/usr/bin/ffmpeg`; they do not start the Worker, Docker, or contact any network service.

## Run locally

```console
mkdir -p /tmp/rc-mech-staged /tmp/rc-mech-work
RC_MECH_MEDIA_STAGING_ROOT=/tmp/rc-mech-staged \
RC_MECH_MEDIA_WORK_ROOT=/tmp/rc-mech-work \
RC_MECH_ANALYSIS_ARTIFACT_ROOT=/tmp/rc-mech-artifacts \
uv run --frozen uvicorn driving_analysis_service.api:app --host 127.0.0.1 --port 8080
```

`GET /health` checks the fixed media executables and local roots. The service is internal-only; a later Worker integration owns authentication, storage mediation, and public routes.

## Subject tracking

`POST /v1/stages/prepare` consumes one staged, validated 16:9 recording. It uses real FFmpeg decoding to extract only the requested Race window and crop exactly the fixed bottom two-thirds Track view. The immutable prepared-video descriptor and compressed frame manifest preserve the source checksum and byte count, absolute source timestamp, zero-based source frame index, Track-view geometry, FFmpeg version, frame rate, pipeline version, and preparation-configuration digest.

`POST /v1/stages/track` starts from the supplied User-equivalent Subject seed and runs one continuous trusted segment. Each observation uses the strict `subject-observation.v1` contract. A non-visible box, provider-specific confidence below the immutable run threshold, or uncertain identity opens a Tracking gap at that frame and stops provider calls immediately. The endpoint writes deterministic gzip JSON plus a descriptor containing the compressed checksum and size and immutable source, prepared-media, FFmpeg, provider, model, pipeline, calibration, threshold, and configuration provenance.

### Ollama local adapter

Ollama's local HTTP API is the `local-http` adapter. It must expose a vision-capable model; this machine's `llava:13b` install reports `vision` and digest `0d0eb4d7f485d7d0a21fd9b0c1d5b04da481d2150a097e81b64acb59758fdef6`. This one command starts the complete processing service against it:

```console
mkdir -p /tmp/rc-mech-staged /tmp/rc-mech-work /tmp/rc-mech-artifacts && \
RC_MECH_MEDIA_STAGING_ROOT=/tmp/rc-mech-staged \
RC_MECH_MEDIA_WORK_ROOT=/tmp/rc-mech-work \
RC_MECH_ANALYSIS_ARTIFACT_ROOT=/tmp/rc-mech-artifacts \
INFERENCE_PROVIDER=local-http \
INFERENCE_PROVIDER_URL=http://127.0.0.1:11434 \
INFERENCE_MODEL=llava:13b \
INFERENCE_MODEL_VERSION=13b-q4_0 \
INFERENCE_MODEL_DIGEST=0d0eb4d7f485d7d0a21fd9b0c1d5b04da481d2150a097e81b64acb59758fdef6 \
INFERENCE_CONFIDENCE_CALIBRATION=llava-13b-manual-v1 \
INFERENCE_IDENTITY_CONFIDENCE_THRESHOLD=0.80 \
uv run --frozen uvicorn driving_analysis_service.api:app --host 127.0.0.1 --port 8080
```

When the service itself runs in local Docker, use the allowlisted `http://host.docker.internal:11434` origin. Startup remains independent of the Worker. The adapter verifies the configured model name, full Ollama digest, and vision capability before a tracking segment, sends the seed and current Track-view frames to `/api/chat`, requests the strict provider-candidate JSON schema with temperature zero, and bounds every response and timeout. Raw Ollama errors and response bodies never enter the processing contract.

For hermetic development, set `INFERENCE_PROVIDER=fake` for a deterministic seed-box provider or `INFERENCE_PROVIDER=fixture` plus `INFERENCE_FIXTURE_PATH=<local JSON path>`. Automated tests use only those adapters and never contact Ollama, a Worker, a remote binding, or a production service.

Confidence is provider-specific: the calibration identifier, threshold, model digest, and resulting configuration digest are pinned in every observation. Values from different configurations or providers must not be compared directly. The synthetic fixture and a successful local Ollama call validate contracts and mechanics only; neither qualifies `llava:13b` for production. Representative private-footage qualification remains in #231 and production packaging in #241.

## Subject benchmark

The provider-neutral Subject-observation contracts and synthetic benchmark are
available without a model or network service:

```console
uv run --frozen subject-benchmark \
  --manifest tests/fixtures/subject-benchmark/manifest.json \
  --ground-truth tests/fixtures/subject-benchmark/ground-truth.json \
  --observations tests/fixtures/subject-benchmark/accepted-observations.json \
  --output /tmp/subject-benchmark-report.json
```

Exit status `0` means the report passes, `1` is a valid benchmark failure, and
`2` means an input contract or file was invalid. Output is canonical JSON and
contains no paths, runner timestamps, media bytes, or model error details. The
committed aggregate intentionally exits `1` because it includes the negative
identity-switch and missed-pass scenarios; its bytes match
`expected-report.json`. A pathless `CorpusRecordingManifest` validates private
checksums and FFprobe facts without source names or annotations.
The manifest pins the Docker image, lockfile, FFmpeg, provider, model, confidence
calibration, configuration, and pipeline provenance copied into the report.
Each recording also pins its decoded frame count and positive average FPS. Cases
must fit their recording duration, and every seed, observation, and annotation
must agree with its zero-based frame index within the manifest's required
`frameTimestampToleranceMs` (the synthetic corpus uses `1` ms). Candidate and
ground-truth intervals are checked against both the case window and recording
duration before evaluation. Candidate gaps must fully cover known ambiguity
spans, subject to the versioned `ambiguityGapCoverageToleranceMs` policy.
Crossing brackets wider than the manifest's maximum observation interval are
ineligible. Coverage stops at the first Tracking gap because this synthetic
harness contains no User Re-identification evidence.
Inputs are size-bounded and output is atomically replaced with owner-only
permissions. The committed executable corpus covers trusted tracking, flagged
ambiguity, an independently annotated unflagged switch, a missed pass, and
gate-timing error. Rejected fixtures cover unknown fields, invalid geometry,
inconsistent centers, invalid timestamp/frame ordering, and unsafe errors.
The fixture corpus tests serialization, ordering, geometry, gap classification,
identity integrity, crossing interpolation, coverage, and timing mechanics
only. Synthetic fixtures do not qualify an inference provider; representative
footage qualification remains out of scope here and belongs to #231.
