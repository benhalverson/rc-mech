FROM python:3.13.11-slim-bookworm@sha256:ac76900038d8606cc99b413d4ede77bc7152f1e42b94cf5d50d4b80a999652fe AS build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /service

RUN python -m pip install --no-cache-dir uv==0.11.0

COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src ./src
RUN uv sync --frozen --no-dev

FROM python:3.13.11-slim-bookworm@sha256:ac76900038d8606cc99b413d4ede77bc7152f1e42b94cf5d50d4b80a999652fe AS runtime

ENV PATH="/service/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    RC_MECH_MEDIA_STAGING_ROOT=/var/lib/rc-mech/staged \
    RC_MECH_MEDIA_WORK_ROOT=/tmp/rc-mech-media

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg=7:5.1.9-0+deb12u1 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/rc-mech/staged /tmp/rc-mech-media \
    && chown -R 10001:10001 /var/lib/rc-mech /tmp/rc-mech-media

WORKDIR /service

COPY --from=build /service/.venv /service/.venv
COPY --from=build /service/src /service/src

USER 10001:10001

EXPOSE 8080

CMD ["uvicorn", "driving_analysis_service.api:app", "--host", "0.0.0.0", "--port", "8080", "--no-server-header", "--no-access-log"]
