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

## Ubuntu host operations

The repository-owned operational assets are in `ops/`. The target is Ubuntu
24.04 with system Docker, NVIDIA Container Toolkit, an encrypted filesystem
mounted at `/var/lib/chassis-notes-gpu`, and `cloudflared` installed from
Cloudflare's package. The install script creates the service skeleton; operators
provision the model, profile, image tag, state mount, and Tunnel credential
outside Git.

The worker is supervised by `chassis-notes-gpu.service` and uses host networking
only because its application binds to `127.0.0.1:8080`. `cloudflared` is a
separate service with one private hostname ingress and a default 404 rule.
Configure the Access application so only the trusted Worker service identity is
admitted. The Access service token remains a Worker secret and is never copied
to this host. Tunnel credentials are root-owned and readable only by the
dedicated `cloudflared` group (mode 0640); the worker cannot read them.

The worker has no application, D1, Workflow, Durable Object, R2-signing, or
Access credentials. Its root filesystem and model/profile mounts are read-only;
only the encrypted state volume and bounded tmpfs are writable. Startup checks
validate Docker, NVIDIA, storage ownership/encryption, model/profile checksum
agreement, and the security flags before starting the container.

The local journal records terminal timestamps and prunes terminal workspaces
after 24 hours. Active jobs and valid `output-ready` artifacts are protected.
Only safe structured lifecycle signals are logged; transfer URLs, request
bodies, media paths/content, provider errors, credentials, hostnames, and
machine identifiers are excluded. A restarted unfinished job is interrupted
and requires fresh Cloudflare authorization.

### Manual operational drill checklist

- Restart each service and reboot the host; confirm Cloudflare reauthorizes work.
- Disconnect Tunnel and reject Access; confirm no local or public inference listener.
- Cancel while transferring and processing, then verify capacity recovers.
- Expire the watchdog and verify stale work is interrupted without deleting active work.
- Expire a transfer grant and reissue the same transfer request.
- Expire the Cloudflare lease while reachable, then cancel while the host is unreachable; verify fencing and capacity recovery.
- Fill the state volume, corrupt a cache/journal, and place stale output; verify fail-closed recovery.
- Verify `ss -ltn` shows only loopback `127.0.0.1:8080`, with no LAN/public worker listener.
- Roll back by stopping both units, restoring the prior image/profile pair, and rerunning preflight.

Never use local state as authority or manually copy Access/R2 credentials to the
host. Artifact acknowledgment and acceptance remain Cloudflare publication
responsibilities; this host only enforces bounded local retention.
