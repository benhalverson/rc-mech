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
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m \
  --mount type=bind,src=/var/lib/chassis-notes-gpu,dst=/var/lib/chassis-notes-gpu \
  --mount type=bind,src=/models/sam3.1.pt,dst=/models/sam3.1.pt,readonly \
  --env GPU_INFERENCE_PROFILE_PATH=/var/lib/chassis-notes-gpu/profile.json \
  --env SAM31_CHECKPOINT_PATH=/models/sam3.1.pt \
  chassis-notes-driving-analysis-gpu
```

The profile file is the canonical versioned Inference profile selected by
Cloudflare. Its digest must match every submission, status, and artifact.
Keep `pipeline.version` at `subject-tracking.v1`, the service's processing
contract version; distinguish implementation changes with the pipeline and
runtime-image digests. A different version in the profile causes the Worker to
reject observation provenance even when inference succeeds.
For new box-seeded candidates, set `promptSemantics` to
`subject-box-corners.v1`. The SAM instance encoder receives both normalized
corners with labels 2 and 3, preserving the user's selected extent. Historical
`subject-box-center-positive-point.v1` profiles retain their single-point
behavior. Pin a new image/profile pair and create a new analysis when changing
prompt semantics; do not rewrite an existing run's profile.

The opt-in `motion-box-gap-recovery.v1` prompt profile uses
`fixed-track-view-motion-crops.v1` preprocessing and
`sam31-motion-gap-consistency-v1` calibration. It evaluates the human seed with
SAM before applying motion proposals to later frames. When observations are
missing, it searches at most 30 source frames and requires three consecutive
trusted detections to resume. Recovery compares foreground appearance and
continued motion; an unconfirmed candidate cannot permanently redirect the
search. Consecutive visible masks reject abrupt aspect-ratio changes before
updating motion or appearance. Shape alone does not prevent person switches.
The candidate also runs SAM's person prompt on bounded single-frame sessions,
refreshing person bounds every five frames and when a candidate approaches a
cached bound. Final exclusion requires overlap with occupied person-mask pixels
plus two pixels; empty corners of a person rectangle do not reject a car.
Candidates are rejected
only when that region is at least 1.5 times the candidate height. SAM can assign
its person label to a car-sized mask; the label alone must not veto a human car
seed. This relative-size guard is a heuristic, not an identity guarantee.
The 48-pixel proximity margin triggers refresh only; it does not exclude nearby
cars. This guard can introduce gaps and still requires full-race validation.
Scores measure consistency, not a probability of correct identity.

Recovery artifacts use `subject-observation-segment.v2` with explicit half-open
closed gaps. No predicted positions become observations, and corner passes
crossing any missing interval remain ineligible. Saved v1 profiles retain their
stop-at-first-gap behavior. Use a fresh analysis with the matching image/profile
pair to evaluate this candidate. A short diagnostic that recovers occlusions is
not full-race acceptance or evidence of zero identity switches.
FastAPI intentionally trusts only Access-authenticated traffic delivered by the
same-host Tunnel; neither the Access service token nor any R2 signing material
is installed in this service.

Decoded JPEGs and the verified working media copy are disposable scratch under
each private job's `execution/work` directory on the disk-backed state volume.
Provision that volume for the admitted media size (up to 50 GiB per input), its
verified working copy, decoded JPEGs, and retained artifacts; the compressed
input size does not bound decoded-frame storage. The prepared bundle hard-links
the immutable transferred files, avoiding another full input copy. The 512 MiB
`/tmp` tmpfs is only for small runtime temporary files. SAM loads at
most two normalized image tensors at a time and retains conditioning frames
plus the forward attention history still eligible for use. Re-identification
starts a new session; these bounded sessions do not support reverse propagation
or edits to already-processed frames. Validate the full recording with its
installed profile before treating these bounds as demo acceptance evidence.

Run the hermetic quality gate without the model extra:

```console
uv run --frozen python -m chassis_notes_gpu_worker.quality
```

## Ubuntu host operations

The repository-owned operational assets are in `ops/`. The target is Ubuntu
24.04 with system Docker, NVIDIA Container Toolkit, a private state directory
at `/var/lib/chassis-notes-gpu`, and `cloudflared` installed from
Cloudflare's package. The install script creates the service skeleton; operators
provision the model, profile, image tag, state mount, and Tunnel credential
outside Git.

### Deploying a GPU release

`pnpm deploy` deploys the frontend, D1 migrations, Cloudflare Worker, Workflows,
and Cloudflare media container. It does not deploy this Ubuntu GPU service.
Building a local demo image also does not update the production image tag or
restart the production container.

For a GPU release, retain the previous image and profile for rollback, build or
promote the validated GPU image to the tag used by the installed systemd unit
(`chassis-notes-driving-analysis-gpu:current`), and install its matching profile
at `/etc/chassis-notes-gpu/profile.json`. Preserve the profile file ownership
and read-only mount permissions. Then restart `chassis-notes-gpu.service` and
wait for loopback `/health` to report `ready` with the expected
`resolvedProfileDigest`. Update the Worker's `INFERENCE_PROFILE_JSON` secret
from that same profile and verify a new real analysis through the authenticated
Worker-to-Tunnel path. A healthy loopback endpoint alone does not verify it.

Existing analyses pin their original profile. Finish or cancel active work
before changing the image/profile pair; use a new analysis for release
verification. Record the running container's image ID and profile digest in
the release evidence, rather than relying on the mutable `:current` tag.

The worker is supervised by `chassis-notes-gpu.service` and uses host networking
only because its application binds to `127.0.0.1:8080`. `cloudflared` is a
separate service with one private hostname ingress and a default 404 rule.
Configure the Access application so only the trusted Worker service identity is
admitted. The Access service token remains a Worker secret and is never copied
to this host. Tunnel credentials are root-owned and readable only by the
dedicated `cloudflared` group (mode 0640); the worker cannot read them.

The worker has no application, D1, Workflow, Durable Object, R2-signing, or
Access credentials. Its root filesystem and model/profile mounts are read-only;
only the private state directory and bounded tmpfs are writable. Startup checks
validate Docker, NVIDIA, storage ownership/permissions, model/profile checksum
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
