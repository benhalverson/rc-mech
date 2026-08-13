# Driving-analysis media validation service

This internal FastAPI service validates one container-local staged Race recording. It owns media inspection only: it does not accept URLs, R2 keys, credentials, public upload metadata, or application identity.

The caller stages the recording as `<stagedMediaId>.media` beneath `RC_MECH_MEDIA_STAGING_ROOT` (default `/var/lib/rc-mech/staged`) and sends the opaque UUID plus the expected byte count to `POST /v1/media/probe`. Validation consumes that temporary staged file. Request work is isolated beneath `RC_MECH_MEDIA_WORK_ROOT` (default `/tmp/rc-mech-media`) and removed after every accepted or rejected result.

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
uv run --frozen uvicorn driving_analysis_service.api:app --host 127.0.0.1 --port 8080
```

`GET /health` checks the fixed media executables and local scratch roots. The service is internal-only; a later Worker integration owns authentication, storage mediation, and public routes.

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
recording checksums and FFprobe facts without recording names or annotations.
The manifest pins the Docker image, lockfile, FFmpeg, provider, model, confidence
calibration, configuration, and pipeline provenance copied into the report.
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
private-footage qualification remains out of scope here and belongs to #231.
The private Main1--Main4 recordings are ignored, read-only verification inputs
for that later work and are never copied into this image.
