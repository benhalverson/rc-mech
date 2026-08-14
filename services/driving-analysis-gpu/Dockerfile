FROM ghcr.io/astral-sh/uv:0.11.0@sha256:e49fde5daf002023f0a2e2643861ce9ca8a8da5b73d0e6db83ef82ff99969baf AS uv

FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04@sha256:ac55d124da4882b497f732d8dfd9a702d5447a5f29d08d56da6f64f0a1eb34bc AS build

ENV DEBIAN_FRONTEND=noninteractive \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates git python3.12 python3.12-venv \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /workspace

COPY containers/driving-analysis containers/driving-analysis
COPY services/driving-analysis-gpu services/driving-analysis-gpu
WORKDIR /workspace/services/driving-analysis-gpu

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --extra sam31 --python /usr/bin/python3.12

FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04@sha256:ac55d124da4882b497f732d8dfd9a702d5447a5f29d08d56da6f64f0a1eb34bc AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/service/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    GPU_WORKER_STATE_ROOT=/var/lib/chassis-notes-gpu

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg python3.12 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o 10001 -g 10001 /var/lib/chassis-notes-gpu

WORKDIR /service
COPY --from=build /workspace/services/driving-analysis-gpu/.venv /service/.venv
USER 10001:10001

CMD ["uvicorn", "--factory", "chassis_notes_gpu_worker.api:create_app", "--host", "127.0.0.1", "--port", "8080", "--no-server-header", "--no-access-log"]
