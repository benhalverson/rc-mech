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
