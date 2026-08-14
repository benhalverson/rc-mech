# Private Driving-analysis GPU worker

This service is the ADR 0028 execution worker for the Owner's RTX 3090. It
reuses the preserved issue 241 SAM 3.1 adapter and runtime from the
provider-neutral Python package; it does not introduce another model
implementation. The Cloudflare media container no longer builds a CUDA target
or exposes Tracking.

The worker accepts exactly one physical execution, owns no durable queue or
application truth, and exposes only the pull protocol used by trusted
Cloudflare TypeScript:

- `GET /health`
- `POST /v1/jobs`
- `GET /v1/jobs/{segmentId}`
- `POST /v1/jobs/{segmentId}/transfer-grants`
- `POST /v1/jobs/{segmentId}/cancel`

Prepared Track-view media and frame manifests are downloaded directly from
private R2 with short-lived GET grants. The compact observation artifact is
uploaded directly with a short-lived PUT grant. Grant URLs live only in the
transfer call's memory and are excluded from the local journal.

Build from the repository root so the shared Python package is available:

```console
docker build -f services/driving-analysis-gpu/Dockerfile \
  -t chassis-notes-driving-analysis-gpu .
```

Run with host networking so FastAPI can bind only to loopback for same-host
`cloudflared`:

```console
docker run --rm --gpus all --network host \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=50g \
  --mount type=bind,src=/encrypted/chassis-notes-gpu,dst=/var/lib/chassis-notes-gpu \
  --mount type=bind,src=/models/sam3.1.pt,dst=/models/sam3.1.pt,readonly \
  --env GPU_INFERENCE_PROFILE_PATH=/var/lib/chassis-notes-gpu/profile.json \
  --env SAM31_CHECKPOINT_PATH=/models/sam3.1.pt \
  chassis-notes-driving-analysis-gpu
```

The profile file is the canonical versioned Inference profile selected by
Cloudflare. Its digest must match every submission, status, and artifact.
FastAPI intentionally trusts only Access-authenticated traffic delivered by the
same-host Tunnel; neither the Access service token nor any R2 signing material
is installed in this service.

Run the hermetic quality gate without the model extra:

```console
uv run --frozen python -m chassis_notes_gpu_worker.quality
```
