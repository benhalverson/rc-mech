FROM ghcr.io/astral-sh/uv:0.11.0@sha256:e49fde5daf002023f0a2e2643861ce9ca8a8da5b73d0e6db83ef82ff99969baf AS uv

FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7 AS build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /service

COPY --from=uv /uv /usr/local/bin/uv

COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src ./src
RUN uv sync --frozen --no-dev

FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7 AS runtime-base

ENV PATH="/service/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    RC_MECH_MEDIA_STAGING_ROOT=/var/lib/rc-mech/staged \
    RC_MECH_MEDIA_WORK_ROOT=/tmp/rc-mech-media \
    RC_MECH_ANALYSIS_ARTIFACT_ROOT=/var/lib/rc-mech/artifacts

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg=7:5.1.9-0+deb12u1 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o 10001 -g 10001 \
        /var/lib/rc-mech/staged /var/lib/rc-mech/artifacts /tmp/rc-mech-media

WORKDIR /service

COPY --from=build /service/.venv /service/.venv
COPY --from=build /service/src /service/src

USER 10001:10001

EXPOSE 8080

FROM runtime-base AS test

USER root
COPY --from=build /usr/local/bin/uv /usr/local/bin/uv
COPY pyproject.toml uv.lock README.md ./
COPY tests ./tests
RUN uv sync --frozen && chown -R 10001:10001 /service
USER 10001:10001
CMD ["python", "-m", "driving_analysis_service.quality"]

FROM runtime-base AS runtime

CMD ["uvicorn", "driving_analysis_service.api:app", "--host", "0.0.0.0", "--port", "8080", "--no-server-header", "--no-access-log"]

FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04@sha256:ac55d124da4882b497f732d8dfd9a702d5447a5f29d08d56da6f64f0a1eb34bc AS sam31-build

ENV DEBIAN_FRONTEND=noninteractive \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates git python3.12 python3.12-venv \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /service

COPY pyproject.toml uv.lock README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --extra sam31 --no-install-project \
        --python /usr/bin/python3.12

COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --extra sam31 --python /usr/bin/python3.12

FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04@sha256:ac55d124da4882b497f732d8dfd9a702d5447a5f29d08d56da6f64f0a1eb34bc AS sam31-runtime-base

ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/service/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    RC_MECH_MEDIA_STAGING_ROOT=/var/lib/rc-mech/staged \
    RC_MECH_MEDIA_WORK_ROOT=/tmp/rc-mech-media \
    RC_MECH_ANALYSIS_ARTIFACT_ROOT=/var/lib/rc-mech/artifacts \
    INFERENCE_PROVIDER=sam31 \
    INFERENCE_MODEL=sam3.1 \
    INFERENCE_MODEL_VERSION=96914d2425f90a64f45ca977c2b5165418099543 \
    INFERENCE_MODEL_DIGEST=0567debeec80ba4ac6369540c6c248025283cb3ff2b92827509e57e2b3541cb6 \
    INFERENCE_CONFIDENCE_CALIBRATION=sam31-point-mask-v1 \
    INFERENCE_IDENTITY_CONFIDENCE_THRESHOLD=0.30 \
    SAM31_CHECKPOINT_PATH=/models/sam3.1.pt

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg python3.12 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o 10001 -g 10001 \
        /var/lib/rc-mech/staged /var/lib/rc-mech/artifacts /tmp/rc-mech-media

WORKDIR /service

COPY --from=sam31-build /service/.venv /service/.venv
COPY --from=sam31-build /service/src /service/src

USER 10001:10001

EXPOSE 8080

FROM sam31-runtime-base AS sam31-runtime

CMD ["uvicorn", "driving_analysis_service.api:app", "--host", "0.0.0.0", "--port", "8080", "--no-server-header", "--no-access-log"]
