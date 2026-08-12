FROM python:3.13.11-slim-bookworm@sha256:ac76900038d8606cc99b413d4ede77bc7152f1e42b94cf5d50d4b80a999652fe AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /service

COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt

COPY app ./app

FROM base AS test

COPY requirements-test.txt ./
RUN pip install --no-cache-dir --requirement requirements-test.txt
COPY tests ./tests

CMD ["python", "-m", "pytest", "-q"]

FROM base AS runtime

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
