# Driving analysis API architecture

**Status:** accepted implementation plan

This document turns the accepted Driving-analysis domain and ADRs into an implementable API and Cloudflare design. It is a clean-slate capability inside Chassis Notes; `rc-racing-line-analysis` is not a code or contract dependency.

The product behavior is defined in [Driving analysis](./specs/driving-analysis.md). Existing ownership, Angular, and media standards continue to apply.

## Outcome

For one existing Drive session, a User uploads a private Race recording, marks the Race window, selects an approved Track-map version, and boxes that Drive session's Car in a frame near the race start. Chassis Notes asynchronously follows that Subject car, measures every eligible Corner pass, retains a cropped Corner clip for each pass, and labels the fastest observed pass for each corner.

AI only emits Subject observations. Reviewed Track-map geometry and deterministic code own gate crossings, eligibility, traversal time, ties, and ranking.

## System shape

```text
Angular Driving-analysis route
        |
        v
Existing authenticated Hono Worker API
        |--------------------------> D1 metadata, lifecycle, and accepted evidence
        |<-- browser parts --------> private ANALYSIS_MEDIA R2 binding
        |-- upload complete -------> RaceVideoValidationWorkflow
        `-- analysis create -------> one DrivingAnalysisWorkflow per run
                                              |
                 |-- named Python media container
                 |        `-- analysis-media.internal --> Worker R2 handler --> private R2
                 |-- singleton GpuLeaseCoordinator Durable Object
                 `-- TypeScript TrackingProvider
                          `-- LocalSam31Provider + Access token
                                      |
                                      v
                            gpu.chassisnotes.com
                                      |
                              Access -> Tunnel
                                      |
                                      v
                            127.0.0.1:8080 FastAPI
                                      |
                              SAM 3.1 -> RTX 3090
```

The existing Worker remains the only browser-facing application API and Angular host under ADR 0001. The Python media service is reachable only through its container binding. The GPU hostname is not a browser API: only the trusted Worker calls it through a fixed-origin provider using Cloudflare Access service authentication, and Cloudflare Tunnel terminates at a loopback-only FastAPI service on the GPU host.

## Responsibilities

| Boundary | Owns | Must not own |
| --- | --- | --- |
| Angular feature | Resumable upload, private video player, Race-window selection, Subject-car box, progress, Re-identification, pass review, accessibility | R2 keys, multipart identifiers, direct persistence, model calls |
| NgRx Signal Store | Creation commands, analysis state, polling lifecycle, cancellation, correction outcomes | DOM coordinates, player handles, endpoint parsing |
| Feature gateway | API URLs, `httpResource` reads, cold mutation Observables, Zod parsing | User-interface state or workflow decisions |
| Hono routes | Authentication, Owner/User authorization, request validation, resource ownership, public DTOs | FFmpeg, model invocation, long-running orchestration |
| Domain rules | State transitions, normalized geometry validation, observation continuity, gate crossing, pass eligibility, ties and ranking | Network, D1, R2, container lifecycle |
| Run-level Cloudflare Workflow | Durable stage sequencing, segment orchestration, retry policy, waiting for Re-identification, cancellation checkpoints | Authoritative application state or large binary artifacts |
| TypeScript `TrackingProvider` | Provider selection, fixed-origin GPU control, strict Zod parsing, lease/fence checks, transfer-grant issuance, retry classification | Media processing, model execution, public lifecycle ownership |
| `GpuLeaseCoordinator` Durable Object | Persisted FIFO waiter ordering, one active lease, lease IDs, monotonically increasing fencing tokens | Analysis lifecycle, evidence, provider work, a second durable job queue |
| Python media container | Media probing, accurate trimming, Track-view crop, frame manifest production, Corner-clip rendering | Tracking, provider selection, Garage ownership, ranking, publishing results directly |
| Local FastAPI GPU worker | Strict Pydantic GPU protocol, one physical execution, SAM 3.1 Tracking segments, disposable caches and recoverable attempt state | Durable queueing, User waits, application credentials, lifecycle or evidence acceptance |
| D1 | Durable metadata, versions, state, measurements, provenance, artifact references | Video bytes, frame images, model files |
| private R2 | Uploaded Race recordings, prepared Track-view media, staged and accepted observations, Corner clips and integrity metadata | Public unauthenticated media or lifecycle authority |

## Video and geometry contract

### Uploaded Race recording

- The browser divides the selected file into fixed-size parts and sends them through authenticated Hono routes backed by the R2 multipart API. This supports files larger than one Worker request without exposing an R2 key, multipart upload ID, or storage credential to the browser.
- The Worker creates an opaque owner/Drive-session/video object key and persists the R2 upload ID plus each completed part number and ETag in D1. Uploads resume across page reloads, and retrying a part idempotently replaces its recorded ETag.
- The server validates the declared file size before upload and the actual R2 object size after completion. Client filenames, extensions, and content types are display hints, not proof of a valid video.
- After multipart completion, the isolated Python container runs FFprobe and a bounded decode sample. The recording becomes `ready` only when duration, dimensions, codecs, timebase, and decode behavior satisfy configured limits; invalid objects are rejected and scheduled for deletion.
- The authenticated Worker streams ready recordings to the browser with byte-range support for the native video element. The R2 bucket has no public development URL or custom domain.
- Default Race-window validation is `startMs >= 0`, `endMs > startMs`, and a maximum duration of 15 minutes. The limit is configuration, recorded with the run, and may be raised after resource benchmarks.

### Track space

- The supported Race recording is 16:9 with invariant framing and a nonmoving main camera.
- The Track view is `x=0`, `y=1/3`, `width=1`, `height=2/3` in full-frame normalized coordinates.
- Track maps, Corner gates, Corner views, Subject seeds, and Subject observations use normalized coordinates in Track-view space, where both axes range from `0` through `1`.
- Resolution changes that preserve the supported framing do not change geometry. A changed aspect ratio, composite layout, camera position, or zoom is rejected as an unsupported recording rather than approximately aligned.
- The Python pipeline preserves the source timebase and reports integer `timestampMs` plus `frameIndex`; it does not assume 30 fps.

### Corner timing

- A gate is a directed finite line segment with two normalized endpoints and an expected direction of travel.
- A crossing exists only when two consecutive trusted Subject observations straddle the gate, the interpolated crossing lies on the finite gate segment, and movement is in the expected direction.
- Crossing time is linearly interpolated using the two observations' timestamps. The underlying frame pair is retained as provenance.
- A pass starts at the entry crossing and ends at the next valid exit crossing for the same corner.
- A pass is ineligible when it overlaps a Tracking gap, has an untrusted crossing bracket, crosses gates out of order, or leaves the Race window.
- Ranking uses unrounded duration in milliseconds. Durations that differ by no more than one source frame are reported as tied rather than arbitrarily choosing a winner.

## Public API

All routes are under the existing authenticated `/api/v1` boundary. Nested creation routes make Car and Drive-session ownership explicit; analysis-ID routes re-check the same ownership through `driving_analysis.owner_id` and the parent Drive session.

### Race-video upload and playback

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `/cars/{carId}/drives/{driveId}/race-videos` | Validate declared size/type and quotas, create the owned D1 record plus R2 multipart upload, and return the stable Race-video ID and part size. |
| `GET` | `/race-videos/{raceVideoId}` | Return owned upload/validation status, metadata, uploaded part numbers, and resumable progress. |
| `PUT` | `/race-videos/{raceVideoId}/upload-parts/{partNumber}` | Ownership-check, validate part bounds and size, stream one request body to R2, and persist its returned ETag. |
| `POST` | `/race-videos/{raceVideoId}/complete` | Complete the multipart upload from server-held part state and start `RaceVideoValidationWorkflow`. |
| `DELETE` | `/race-videos/{raceVideoId}` | Abort an incomplete upload or delete a completed owned recording when no analysis is actively using it. |
| `GET` | `/race-videos/{raceVideoId}/content` | Ownership-check and stream a ready recording with byte-range support. Never reveal its R2 key. |

Creation request:

```json
{
  "fileName": "a-main-race.mp4",
  "sizeBytes": 1468006400,
  "contentType": "video/mp4",
  "requestId": "018f..."
}
```

Creation response:

```json
{
  "raceVideo": {
    "id": "018f...",
    "status": "uploading",
    "fileName": "a-main-race.mp4",
    "sizeBytes": 1468006400,
    "partSizeBytes": 10485760,
    "uploadedPartNumbers": []
  }
}
```

All public Race-window and Subject timestamps are absolute millisecond positions on the uploaded Race recording. Stage-local offsets remain internal implementation details.

### Analysis lifecycle

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/cars/{carId}/drives/{driveId}/driving-analyses` | Validate the active owned Car, undeleted Drive session, ready Race video, approved Track-map version, window, and seed. Create D1 state and start a Workflow. Return `202`. |
| `GET` | `/cars/{carId}/drives/{driveId}/driving-analyses` | List analyses for the Drive session, newest first. |
| `GET` | `/driving-analyses/{analysisId}` | Return authoritative state, stage, progress, gaps, per-corner summaries, and current run provenance. |
| `POST` | `/driving-analyses/{analysisId}/reidentifications` | Append a User correction for one open Tracking gap and signal the waiting Workflow. |
| `POST` | `/driving-analyses/{analysisId}/retry` | Create a new run from a retryable failed or completed analysis while preserving prior provenance. |
| `POST` | `/driving-analyses/{analysisId}/cancel` | Idempotently request cancellation. Completed and deleted analyses cannot be cancelled. |
| `DELETE` | `/driving-analyses/{analysisId}` | Mark deleting, cancel active work, delete private artifacts asynchronously, and retain a minimal deletion tombstone. |
| `GET` | `/driving-analyses/{analysisId}/artifacts/{artifactId}` | Ownership-check and stream a retained clip with byte-range support. Never reveal the R2 key. |

Creation request:

```json
{
  "raceVideoId": "018f...",
  "raceWindow": {
    "startMs": 1872000,
    "endMs": 2222000
  },
  "trackMapVersionId": "018f...",
  "subjectSeed": {
    "timestampMs": 1875000,
    "box": { "x": 0.43, "y": 0.71, "width": 0.035, "height": 0.052 }
  },
  "requestId": "018f..."
}
```

Creation response:

```json
{
  "analysis": {
    "id": "018f...",
    "status": "queued",
    "stage": "preparation",
    "progress": 0,
    "driveSessionId": "018f...",
    "carId": "018f..."
  }
}
```

`requestId` is a client-generated UUID used to make creation idempotent. Re-identification and retry commands also carry client-generated command IDs.

Owned analysis responses expose stable run and Tracking-segment provenance: run ID, Inference-profile digest, segment ID/order/outcome, gap descriptors, and accepted-artifact digest. They never expose attempt or transfer-request IDs, lease IDs, fencing tokens, staging or private object keys, Access details, the GPU hostname, or machine identifiers.

### Track-map administration

| Method | Path | Authorization |
| --- | --- | --- |
| `GET` | `/track-layouts` | Authenticated Users see approved versions; Owner additionally sees drafts and retired versions. |
| `POST` | `/track-layouts` | Owner only. |
| `POST` | `/track-layouts/{layoutId}/map-versions` | Owner only; create a draft from nothing or an existing version. |
| `PATCH` | `/track-map-versions/{versionId}` | Owner only; draft versions only. |
| `POST` | `/track-map-versions/{versionId}/approve` | Owner only; validate complete nondegenerate geometry and publish immutably. |
| `POST` | `/track-map-versions/{versionId}/retire` | Owner only; prevents new analyses without changing existing ones. |

The server identifies the application Owner by comparing the authenticated User's normalized email with the configured `OWNER_EMAIL`; the client never supplies or asserts the role.

## State model

The public status is coarse and stable. `stage` supplies operational detail without expanding the state machine for every implementation step.

```text
Race video:
uploading -> validating -> ready
                      `-> invalid
uploading | validating | ready | invalid -> deleting -> deleted

Driving analysis:
queued
  -> running
       -> awaiting-reidentification -> running
       -> completed
       -> failed
       -> cancelled
  -> cancelled

completed | failed | cancelled
  -> deleting -> deleted
```

Race-video validation uses `probing` and `decode-validation` stages before an analysis exists. Driving-analysis stages are `preparation`, `tracking`, `measurement`, `clip-rendering`, and `finalization`. D1 is authoritative because completed Workflow state has platform retention limits.

Provider states such as downloading, processing, output readiness, transfer activity, retry, recovery, and lease waiting are internal. Before the first Tracking segment starts, provider or capacity waits remain public `queued` with `waiting-for-provider` or `waiting-for-capacity`. After any Tracking evidence is accepted, later waits remain `running` at `tracking` and never regress to `queued`. Exact queue position is not public. Progress is a monotonic high-water mark within one run, capped at 99 until the authoritative final commit publishes 100; a new run may reset progress.

Version-one GPU scheduling is persisted FIFO and non-preemptive. Each newly ready segment, including one created by Re-identification, joins the tail. Infrastructure retry preserves the segment's original waiter ordinal, cancellation removes it, and an executing segment retains the physical GPU until a defined segment termination condition.

Failures use stable public codes:

- `VIDEO_NOT_READY`
- `VIDEO_INVALID`
- `VIDEO_UNAVAILABLE`
- `UPLOAD_INCOMPLETE`
- `INVALID_RACE_WINDOW`
- `UNSUPPORTED_VIDEO_LAYOUT`
- `TRACK_MAP_UNAVAILABLE`
- `SUBJECT_NOT_FOUND`
- `TRACKING_PROVIDER_UNAVAILABLE`
- `TRACKING_PROVIDER_FAILED`
- `TRACKING_ARTIFACT_INVALID`
- `ARTIFACT_WRITE_FAILED`
- `RESOURCE_LIMIT_EXCEEDED`
- `PROCESSING_FAILED`

Provider exception text, credentials, media URLs, prompts, and response bodies are not returned or persisted as public errors.

## Workflow stages

1. **Validate video and ownership** — reload the ready Race-video object, its R2 metadata, every parent record, Track-map version, immutable Inference profile, and command idempotency key.
2. **Prepare Race window once per run** — the named media container reads the uploaded recording through the constrained R2 handler, decodes only the selected interval, crops the fixed Track view, and publishes immutable prepared media plus a frame manifest and checksums to private R2.
3. **Create an immutable Tracking segment** — bind the initial Subject seed or accepted Re-identification, prepared-media descriptor, Race-window end, Inference-profile digest, and versioned segment specification into one digest.
4. **Acquire GPU capacity** — enqueue the segment once in the singleton coordinator's persisted FIFO order. On acquisition, conditionally activate the lease ID and fencing token in D1 before issuing a transfer grant or contacting the provider.
5. **Execute and accept the segment** — `LocalSam31Provider` submits idempotently, polls the Access-protected worker, renews authority only from matching status, and supplies ephemeral GET or PUT grants through the shared transfer handshake. A successful output is staged, independently validated, promoted to a grant-inaccessible accepted key, and atomically committed in D1 before lease release.
6. **Wait for Re-identification when required** — only an accepted `tracking-gap` artifact publishes `awaiting-reidentification`. The Workflow uses `step.waitForEvent` without a GPU lease or local pending job.
7. **Resume with a new segment** — an accepted Re-identification creates the next immutable segment at the first clear frame. Infrastructure retry creates a new attempt under the existing segment instead.
8. **Measure** — TypeScript deterministic rules validate accepted observation continuity, interpolate gate crossings, construct eligible Corner passes, apply tie rules, and persist measurements transactionally.
9. **Render clips** — the media container receives only validated clip specifications, crops each Corner view, adds unobtrusive Subject-center and gate overlays, and writes browser-compatible H.264 MP4 clips without audio.
10. **Finalize** — verify R2 checksums and sizes, rank passes per corner, publish `completed` and 100 percent progress, and schedule deletion of prepared working media.

One Workflow instance owns one immutable run and reloads D1 after every wake, retry, and replay. Each non-Tracking stage is idempotent on `(runId, stage, inputDigest)`; Tracking idempotency additionally distinguishes immutable segment identity from mutable execution attempts. Workflow step outputs contain small descriptors, never video, Transfer-grant URLs, or full observation arrays.

## Python media container contract

The Cloudflare service lives at `containers/driving-analysis/`, listens on one internal port, and exposes only the media stages that require its FFmpeg runtime:

| Method | Internal path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Process and media-runtime readiness. |
| `POST` | `/v1/media/probe` | Probe and bounded-decode a completed upload before it can become ready. |
| `POST` | `/v1/stages/prepare` | Read the owned Race recording through the R2 handler, trim, crop, and store working media. |
| `POST` | `/v1/stages/render` | Render an immutable list of validated Corner-clip specifications. |

The container has `enableInternet=false` and no GPU-control responsibility. It reaches private R2 only through ADR 0027's named outbound handler and never receives the local GPU Access credential.

## Tracking provider and local GPU contract

The provider-neutral `TrackingProvider` interface lives in trusted TypeScript. Its initial `LocalSam31Provider` is configured with one normalized HTTPS origin, builds only relative paths, rejects redirects, injects the Access service token only for an exact origin match, and bounds every request and response before strict Zod parsing.

Every submission names the run's canonical Inference-profile digest. The local worker resolves its installed model, pipeline, runtime, and inference-affecting configuration and rejects anything other than an exact match. Cloudflare treats a selected worker that no longer supports the run's profile as unavailable under that segment's existing 24-hour deadline; it never substitutes the worker's newer profile.

The local FastAPI service exposes a small versioned execution API through Cloudflare Access and Tunnel:

| Method | Internal path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Report bounded process, installed-profile, and physical-capacity readiness. |
| `POST` | `/v1/jobs` | Idempotently submit one segment execution under an activated lease and attempt. Return `202` when accepted. |
| `GET` | `/v1/jobs/{segmentId}` | Report internal execution status bound to segment, attempt, lease, fence, and profile digest. |
| `POST` | `/v1/jobs/{segmentId}/transfer-grants` | Deliver one ephemeral GET or PUT grant for a stable transfer-request ID. |
| `POST` | `/v1/jobs/{segmentId}/cancel` | Idempotently request cooperative cancellation for the exact active authority. |

The local worker has no durable queue and accepts at most one physical execution. Every local job is one continuous Tracking segment, and local status never becomes the public Driving-analysis lifecycle. A Tracking gap is a successful local `completed` outcome; Cloudflare alone accepts its artifact and publishes `awaiting-reidentification`. A status of `transfer-grant-required` carries only stable transfer identity and role; the delivered URL exists in memory only and is discarded after use.

GPU control requests contain only small descriptors. The GPU worker receives a grant for the immutable prepared Race-window Track-view artifact and frame manifest, never the original Race recording; media bytes flow directly from R2 to the GPU host rather than through the Worker, Python container, or Tunnel request body. Compact observation artifacts flow directly back to R2 through the corresponding PUT grant.

Both Python services use strict Pydantic models with extra fields rejected. The Worker uses corresponding strict Zod schemas, and shared accepted and rejected fixtures prove Zod-to-Pydantic parity for provider-neutral observation, segment, status, transfer, and artifact contracts.

A provider-neutral Subject observation contains:

```json
{
  "frameIndex": 217,
  "timestampMs": 1882234,
  "box": { "x": 0.42, "y": 0.69, "width": 0.036, "height": 0.051 },
  "center": { "x": 0.438, "y": 0.716 },
  "identityConfidence": 0.994,
  "visibility": "visible",
  "origin": "detected"
}
```

The configured threshold and provider-specific confidence calibration are part of run provenance. The public domain does not assume confidence values from different models are directly comparable.

### Tracking artifact acceptance

1. The worker finalizes a successful segment artifact locally and reports `output-ready` with attempt, segment, specification, profile, lease, and fencing identities plus contract version, checksum, and byte count.
2. Cloudflare verifies that D1 and the coordinator still agree on that active authority, then sends a short-lived PUT grant for an attempt-specific staging key through the stable transfer-request handshake.
3. The worker uploads once from memory and reports transfer completion. Grant expiry reuses the same transfer-request ID; it never creates another segment, attempt, or specification.
4. Cloudflare independently reads and validates the staged object's checksum, byte count, strict contract, successful outcome, segment binding, specification digest, profile digest, lease ID, and fencing token.
5. Cloudflare promotes the exact validated bytes to an accepted-evidence key that is never exposed through a PUT grant and validates the promoted object.
6. Cloudflare acquires a bounded coordinator commit hold conditioned on the same lease and fencing token. The hold prevents lease expiry or reassignment during the final conditional D1 transaction but stores no evidence.
7. Cloudflare commits the accepted key and checksum in D1 exactly once, then releases the successful lease. Cancelled, expired, stale, interrupted, or failed attempts receive no new grant and can never bind staging or an orphaned promotion as evidence.

## Persistence model

The exact migration can evolve during implementation, but these ownership and immutability boundaries are required.

| Record | Important fields and relationships |
| --- | --- |
| `race_video` | owner, Car, Drive session, server-generated R2 key, display filename/type, declared/actual size, upload ID, status, validated media metadata, timestamps |
| `race_video_upload_part` | Race video, part number, ETag, byte count, completed timestamp; unique per video and part number |
| `track_layout` | stable layout identity, venue/name, active/retired state |
| `track_map_version` | layout ID, integer version, draft/approved/retired state, reference source metadata, creator, approval timestamp |
| `track_corner` | map-version ID, stable corner key, order, name, entry/exit gate coordinates, Corner-view coordinates |
| `driving_analysis` | owner, Car, Drive session, Race-video ID, Race window, pinned map version, seed, status/stage/progress high-water mark, current run, timestamps |
| `driving_analysis_request` | owner and client request ID, request digest, analysis ID, outcome; prevents duplicate jobs |
| `inference_profile` | canonicalization version, immutable inference-affecting configuration, profile digest; excludes leases, timing, hardware, and transfer details |
| `tracking_run` | analysis, owner, sequence, Workflow ID, Inference-profile digest, status/version, input digest, started/completed timestamps; one immutable profile and one Workflow per run |
| `tracking_run_input` | run/owner, Race-video ID and private source key, source checksum/size, exact Race window, approved Track-map version, fixed source-layout version/digest/dimensions; immutable and unique per run |
| `prepared_tracking_media` | run, immutable preparation descriptor, source/preparation/media/frame-manifest digests, byte counts, exact Race window; immutable and unique per run |
| `prepared_tracking_object` | prepared-media/run identity, media or frame-manifest role, private R2 key, checksum, byte count, content type/encoding; exactly one of each role per accepted descriptor |
| `prepared_tracking_retention` | run/prepared-media identity, earliest deletion time, active/deleted state, optimistic version, deletion timestamp; mutable only through the terminal cleanup transition |
| `tracking_segment` | immutable ID/run/order, initial or Re-identification seed, prepared-media descriptor, specification version and digest, availability deadline, successful outcome, accepted-artifact binding |
| `tracking_execution_attempt` | segment and attempt IDs, mutable internal state, active lease ID/fencing token, profile digest, timing and bounded diagnostics; never a Transfer-grant URL |
| `tracking_transfer_request` | stable ID, attempt, GET/PUT role, logical object descriptor, state; grant material is never persisted |
| `subject_observation_artifact` | run and segment, accepted R2 reference, contract/profile/specification digests, checksum, byte count, first/last timestamps, outcome and optional gap descriptor |
| `tracking_gap` | run, start timestamp, reason code, correction state |
| `reidentification` | gap, client command ID, User, timestamp, normalized box, created timestamp; append-only |
| `corner_pass` | run, corner, ordinal, crossing timestamps/frame pairs, duration, eligibility/exclusion, rank and tie group |
| `analysis_artifact` | owner, analysis/run, kind, private R2 key, content type, byte count, checksum, retention/deletion timestamps |

Approved Track-map versions, Inference profiles, Tracking-segment specifications, accepted observation artifacts, Re-identifications, completed run provenance, and measured Corner passes are immutable. Attempt state may change only through fenced transitions. A rerun creates a new run, Workflow, and Tracking evidence and promotes that run as current without deleting prior evidence. It may reuse immutable source inputs, but it cannot consume observations accepted under the previous run's profile.

## Private media and retention

- Add a separate private R2 bucket and Worker binding named `ANALYSIS_MEDIA`; do not mix multi-megabyte analysis artifacts into the compatibility-sensitive `PHOTOS` bucket.
- Use owner/Drive/video prefixes for uploads and owner/analysis/run prefixes for derived artifacts. Every key is opaque, server-generated, never accepted from a client, and never returned in public DTOs.
- Uploaded Race recordings remain private and reusable by analyses for the same Drive session until the User deletes them. Deletion is refused while an analysis is active; completed analyses retain their derived evidence but cannot be retried after their source recording is deleted.
- Incomplete multipart uploads expire and are aborted automatically. Their D1 upload-part records are then deleted.
- Working Race-window media is retained while a run is active or awaiting Re-identification, then deleted within 24 hours after completion, cancellation, or terminal failure.
- Accepted prepared Track-view objects remain checksum-bound to their immutable descriptor. Cleanup requires both their configured retention time and at least 24 hours since the owning Tracking run became terminal; the deletion record advances monotonically and retries are idempotent.
- Attempt-specific staging objects and promoted objects not referenced by a successful D1 commit are never evidence and are garbage-collected within 24 hours. Accepted Subject observations use separate keys that no Transfer grant can write.
- Compressed accepted Subject observations and every eligible Corner clip remain until the User deletes the Driving analysis. These are the retained provenance needed to explain a result.
- Do not retain extracted full frames, model masks, or debug video by default.
- Presigned Transfer-grant URLs are never stored in D1 or R2 metadata, written to logs, included in provenance, or hashed into idempotency inputs.
- Deletion is idempotent and recoverable only while R2 object deletion has not completed. The UI must state when deletion becomes permanent.
- Artifact reads go through the authenticated Worker with ownership checks and byte-range support. The bucket has no `r2.dev` or custom-domain public access.

## Cloudflare media-container isolation

- Use one named container instance per validation or media-processing run, addressed by its validation/run ID; do not randomly load-balance stateful stage requests.
- Benchmark FFmpeg preparation and rendering with `standard-4`, then downsize only if representative media still passes processing targets. Start with `max_instances: 2` to bound platform spend.
- The image is `linux/amd64`, pinned by digest in run provenance, and contains FFmpeg, the media Python service, and no Tracking model or development tools.
- Set `enableInternet = false` in production. Export `ContainerProxy` and allow only explicit virtual hosts.
- `analysis-media.internal` is an `outboundByHost` Worker handler that validates the container/run identity and translates constrained HTTP range reads and writes into the `ANALYSIS_MEDIA` R2 binding.
- ADR 0027 remains in force for this mediated R2 path. GPU control originates in trusted Worker code and does not add a container egress host or a Python hop.
- Container disk is scratch space only. Every stage must tolerate a fresh disk after sleep or rollout.

## Local GPU host

- Run `cloudflared` and the FastAPI inference worker as persistent system services that start after reboot and restart after failure. FastAPI listens only on `127.0.0.1:8080`; the host exposes no LAN or public inference port.
- `cloudflared` initiates the connection outbound to Cloudflare, so the GPU host requires no port forwarding, static address, inbound firewall opening, or publicly exposed home IP.
- Use a dedicated least-privilege service account and encrypted local storage. The worker holds no R2 signing, Access, application, D1, Workflow, or Durable Object credential.
- Enforce one physical GPU execution in the local worker even when Cloudflare has reassigned an expired lease. The worker has no local durable queue; a second submission receives `GPU_CAPACITY_BUSY`.
- A minimal local execution journal may retain identities, specification/profile digests, mutable state, and an `output-ready` descriptor for recovery. It never stores a Transfer grant. Host restart marks unfinished computation interrupted and requires fresh Cloudflare authorization before another attempt can run.
- Prepared media may use a checksum-keyed cache with a seven-day default TTL and a configured disk budget. Finalized local outputs are deleted after Cloudflare acknowledges acceptance or after 24 hours. Model weights and compiled model caches may persist across segments. Every cache is an optimization and is revalidated before use.

Starting timing defaults are configuration rather than domain state:

| Setting | Default |
| --- | --- |
| Provider status poll | 15 seconds |
| GPU lease lifetime | 90 seconds |
| Local control-plane watchdog grace | 120 seconds |
| Cancellation grace before lease release | 60 seconds |
| GPU control-request timeout | 10 seconds |
| Artifact D1 commit hold | 30 seconds |
| Provider-unavailable backoff | Full jitter from 5 seconds, capped at 5 minutes |
| Input GET Transfer grant | 30 minutes, renewable |
| Output PUT Transfer grant | 10 minutes, renewable |
| Ready-segment provider deadline | 24 hours, never extended by retry |

Lease renewal requires a matching current status response and a still-current D1 record. Control-plane silence lets the lease expire before the local watchdog aborts stale physical work. These values should be tuned from production measurements without changing the lifecycle or fencing invariants.

### Lease and failure recovery

- The coordinator assigns one unique lease ID and the next persisted fencing token to the FIFO head. Cloudflare then conditionally activates that identity in D1; no GPU request or Transfer grant is permitted before the D1 commit. A bounded commit hold is part of this lease coordination and prevents reassignment only during the final evidence transaction.
- If activation fails, release the unused lease or let it expire. If recovery finds D1 and the coordinator disagree, fence the attempt and reconcile from D1/R2 instead of guessing which side won.
- Polling is Cloudflare-initiated. Every status response must match the current segment, attempt, lease, fence, and profile digest; only then may Cloudflare renew the coordinator lease and persist monotonic internal progress.
- Cancellation first transitions D1 so late work is fenced, then stops grant issuance and lease renewal and sends an idempotent local cancel. Release the lease after local confirmation or after the 60-second grace if the worker is unreachable.
- Lease release does not prove physical computation has stopped. If a newly leased submission encounters stale physical work, the local worker returns `GPU_CAPACITY_BUSY`; Cloudflare releases the unstarted lease and restores the same waiter at the FIFO head with its original ordinal and deadline.
- A local reboot never resumes computation on local authority. An unfinished execution becomes interrupted and a fresh Cloudflare-authorized attempt reuses the immutable segment; an already finalized `output-ready` attempt remains idempotently reportable under its original attempt identity.

## Client feature boundary

Colocate the feature under `client/src/app/car/drive-sessions/driving-analysis/` and lazy-load it below the selected Car's Drive-session route.

- `DrivingAnalysisStore` owns upload creation/resume, upload and validation progress, analysis creation, progress polling, cancellation, retry, gaps, corrections, and review state for one analysis route.
- `DrivingAnalysisGateway` owns all API URLs and Zod response parsing.
- A focused private-video player capability owns the native video handle, seeking, current-time reads, and canvas-to-video coordinate mapping; it exposes no HTTP or workflow state.
- The Race-window and Subject-box editors own Signal Forms, pointer/keyboard interaction, canvas overlay, focus, and validation.
- The review component renders corners, all eligible passes, ties, the Best-corner label, clips, provenance, and excluded/gap explanations.
- Version one polls the authoritative analysis resource while work is active, using a short foreground interval with backoff when the tab is hidden. It does not add a Durable Object or WebSocket solely for progress.
- Server-dependent analysis is explicitly unavailable during an Offline session. Creating an analysis is not added to the offline mutation queue.

Accessibility requirements include keyboard-operable start/end marking and box adjustment, text equivalents for all geometry, visible focus, non-color-only best/gap states, reduced-motion-safe progress, captions that describe muted clips, and AXE coverage of every workflow state.

## Security and abuse controls

- Never accept an R2 object key, multipart upload ID, or arbitrary fetch URL from the browser. Resolve all storage operations from the authenticated Race-video record.
- Validate upload ownership, status, part number, byte count, declared total, quota, and optimistic state witness on every multipart command. Complete only from the server-held ETag set.
- Treat filename extensions and browser content types as untrusted display metadata. FFprobe and bounded decoding in the egress-denied container determine whether the object is supported media.
- Re-check User ownership at every API and Workflow boundary, including after retries and wakeups.
- Only the configured application Owner may mutate Track maps.
- Normalize the HTTPS-only GPU origin once from deployment configuration. Provider code accepts only relative paths, rejects redirects and alternate origins, and injects the Access service token only after an exact origin match; D1 and request data can never choose a host, scheme, or port.
- Protect the GPU application with an Access Service Auth policy that accepts only the Worker-held service token. Keep that secret at the Worker boundary; neither Python service receives it, and local FastAPI trusts only Access-authenticated Tunnel traffic arriving on loopback.
- Generate Transfer grants only after lease-first, conditional D1 activation. Bind each grant delivery to the current segment, attempt, lease, fencing token, profile digest, role, and stable transfer-request ID.
- Keep R2 signing material at the Worker secret boundary. Grants are exact-method, exact-object, short-lived execution capabilities; reissuance preserves the transfer-request ID and is excluded from provenance and idempotency inputs.
- Accept Tracking evidence only after current-authority checks, strict contract and identity validation, checksum and byte-count validation, promotion away from the grant-writable staging key, and one conditional D1 commit.
- Use strict duration, coordinate, corner-count, clip-count, and object-size limits. Reject nonfinite coordinates and degenerate gates/views.
- Do not construct shell command strings from requests. Invoke FFmpeg with argument arrays and validated local paths.
- Never log upload bodies, video frames, model inputs, Subject boxes, Transfer-grant or internal media URLs, Access headers, multipart identifiers, or R2 object bodies.
- Redact container/provider exception text before it reaches D1 or clients. Structured internal logs retain only safe error class and stage.
- Enforce per-file, retained-storage, incomplete-upload, and active-analysis quotas per User. Rate-limit upload creation and analysis creation without throttling legitimate authenticated part transfer.
- Cancellation and deletion are ownership-checked commands, not direct Workflow or R2 identifiers supplied by the browser.

## Local development

- Use the same media-container Dockerfile and Python media-stage contract locally and in Cloudflare.
- `wrangler dev` runs the media container through local Docker and supports ADR 0027's same outbound-handler shape.
- TypeScript tests inject a fake `TrackingProvider`; local integration may select `LocalSam31Provider` against a developer-controlled endpoint, but production provider selection and its Inference profile remain immutable per run.
- Automated tests upload a tiny licensed/synthetic fixture through the multipart API and use fake inference observations plus local D1, R2, Workflow, Durable Object, and GPU-control doubles. They never contact the home GPU, Cloudflare Access, production D1/R2, or the deployed Worker.
- A private candidate-generation operation resolves authorized benchmark objects and runs the selected provider outside the Git worktree. The separate hermetic benchmark command consumes only reviewed manifests, annotations, and stored provider-neutral observations; it never fetches media, invokes a provider, or reads credentials.
- Record the canonicalization version, Inference-profile digest and content, media-image digest, Python lockfile hash, FFmpeg version, model digest, runtime-image digest, and pipeline digest in every benchmark report.

## Observability

Every safe log and metric carries `analysisId`, `runId`, and `stage`; internal Tracking telemetry also carries `segmentId` and `attemptId`. Lease and fencing identities may appear only in access-controlled structured telemetry, never public errors. Transfer-grant URLs and Access credentials are always redacted.

Track:

- stage wall time, active media-container time, GPU execution time, retries, cold starts, and terminal errors;
- FIFO wait time, lease acquisition/renewal/expiry, provider reachability, Access/Tunnel failures, watchdog aborts, physical-capacity conflicts, and cancellation-grace expiry;
- Race-window duration, decoded frame count, observation count, gap count and duration;
- prepared-media and model-cache hits, transfer bytes and duration, staging garbage collection, and artifact-validation failures;
- eligible/ground-truth Corner-pass coverage in benchmarks;
- identity-switch benchmark failures as a separate release-blocking measure;
- gate-timing error distribution, clip count, R2 bytes written/deleted, and retained bytes per analysis;
- Inference-profile digest, provider/model/runtime/pipeline versions, and cost attribution.

D1 state, not logs or the Workflow dashboard, supports the User-facing progress view.

## Verification

### TypeScript

- Pure tests cover multipart state, size/part validation, normalized geometry, finite gate intersection, direction, timestamp interpolation, gap overlap, eligibility, tie handling, ranking, public-state projection, profile canonicalization, idempotency, and retention rules.
- Hono tests call public `app.request(path, init, MOCK_ENV)` with typed D1, R2, Workflow, container, coordinator, and `TrackingProvider` doubles. No test loads live Wrangler bindings or remote services.
- Workflow tests prove run-level ownership, completed steps are not repeated, segment retry preserves identity, Re-identification creates a segment, retryable and nonretryable errors diverge, waiting/resume is idempotent, cancellation fences late completions, and a stale run cannot become current.
- Coordinator tests prove persisted FIFO order, monotonic fencing, lease-first/D1-activation ordering, renewal/release conditions, stale-capacity head restoration, cancellation grace, and replay after Durable Object restart.
- `LocalSam31Provider` tests prove fixed-origin HTTPS normalization, redirect and absolute-URL rejection, exact Access-header scope, time and size bounds, strict status identity, profile-digest matching, shared transfer-grant handshakes, and two-phase accepted-artifact promotion.
- Ownership tests cover another User's analysis, Drive session, clips, request IDs, and correction IDs; Track-map mutations require the configured Owner.

### Python

- Media-service unit tests cover strict request models, FFmpeg argument construction, accurate trimming, Track-view and Corner-view pixel conversion, frame manifests, and safe error mapping.
- Media fixture integration tests run real FFmpeg through probe, prepare, and render endpoints without a Tracking model.
- GPU-worker unit and integration tests cover capacity one, idempotent submission and cancellation, restart reauthorization, liveness watchdog, exact profile resolution, transfer-grant disposal, Tracking-gap success, output-ready recovery, and no acceptance authority.
- Contract tests share accepted and rejected JSON fixtures with the TypeScript Zod schemas across both Python services.
- The representative benchmark contains at least three complete Race windows, produces zero unflagged identity switches, and automatically emits at least 80% of ground-truth Corner passes as eligible.

### Angular and browser

- Component, store, gateway, and pure-rule tests remain colocated and satisfy the configured 100% per-file coverage gate.
- Playwright uses the production Angular build, local Worker, fake processing provider, and synthetic fixture to cover resumable upload, exact Race window, keyboard/pointer Subject selection, progress, Re-identification, all-pass review, ties, cancellation, deletion, and AXE.
- A browser smoke uploads and plays an owned fixture through the real deployed private-R2 path without placing production media in CI.

## Delivery slices

Each slice should be independently reviewable and keep tests green before the next begins.

The SAM 3.1 slices reuse the validated adapter, runtime, contracts, fixtures, and tests preserved from the issue 241 work rather than starting a second model implementation. Container-specific hosting assumptions from that work are replaced by ADR 0028's local-worker boundary.

1. **Benchmark harness and fixture contract** — establish manual annotations, shared observation schema, candidate provider adapters, and the zero-switch/80%-coverage report before selecting a model.
2. **Track-map domain and Owner authorization** — migrations, pure geometry rules, Owner-only Hono APIs, immutable approval/versioning, and focused tests.
3. **Race-video upload API** — migrations, authenticated multipart create/part/complete/abort routes, D1 resume state, quotas, validation lifecycle, private range playback, OpenAPI, and ownership tests.
4. **Run Workflow and persistence skeleton** — one Workflow per run, immutable Inference profiles and Tracking segments, mutable fenced attempts, D1 progress projection, wait-for-event Re-identification, and fake media/provider ports.
5. **Python media service** — container scaffold, health, probe, prepare, and render endpoints; FFmpeg validation/trim/crop, frame manifests, ADR 0027 R2 egress, synthetic fixture integration, and image hardening.
6. **Provider-neutral Tracking contract and SAM 3.1 runtime** — Subject seeds, segment/profile digests, observations, confidence/gap behavior, strict Pydantic models, parity fixtures, benchmark integration, and no ranking in the model service.
7. **GPU lease and TypeScript provider control plane** — singleton FIFO coordinator, fencing, `TrackingProvider`, fixed-origin `LocalSam31Provider`, Access-secret injection, deadlines, cancellation, status projection, and fake-provider coverage.
8. **Local GPU execution service** — FastAPI job state machine, capacity one, restart recovery, watchdog, grant handshake, two-phase outputs, SAM 3.1 on the RTX 3090, loopback binding, `cloudflared`, and persistent system services.
9. **Accepted-artifact and deterministic evidence engine** — staged validation and promotion, continuity, gate crossings, pass eligibility, ties/ranking, D1 commits, and rerun provenance.
10. **Clip rendering and private playback** — Corner-view/padding render requests, H.264 output, R2 retention/deletion, authenticated range streaming, and ownership tests.
11. **Angular creation and correction workflow** — lazy route, gateway/store, resumable upload, private video player, Race-window editor, accessible Subject boxing, coarse wait reasons, monotonic progress, and Re-identification.
12. **Angular evidence review** — per-corner pass comparison, Best/tie labels, clips, gaps/exclusions, stable run/segment provenance, deletion, Playwright, and AXE.
13. **Release hardening** — representative SAM benchmark, full backend/client/architecture/browser coverage, dry-run deploy, Container and local-service restart verification, Access/Tunnel and R2 privacy checks, production migration check, and lease/failure/cancellation drills.

## Completion contract

Version one is complete only when:

- every accepted workflow rule in `docs/specs/driving-analysis.md` is exposed through the authenticated API and accessible UI;
- the production model passes zero unflagged identity switches and at least 80% automatic Corner-pass coverage on the versioned benchmark;
- old Track-map versions and old processing runs remain reproducible and unchanged;
- no client-controlled R2 key, arbitrary provider origin, public R2 object, broad container egress, leaked Transfer grant or Access secret, remote automated test, or raw provider error remains;
- cancellation, retries, Re-identification, media-container restart, GPU-host restart, Workflow replay, lease expiry, stale execution, and artifact deletion are idempotent and fenced;
- every accepted Tracking artifact matches its run, segment specification, active fencing identity, and exact Inference-profile digest;
- the full repository lint, format, TypeScript, backend coverage, Angular 100% per-file coverage, production build, Playwright, AXE, dry-run deploy, and relevant production acceptance checks pass.

Version one has no external media-acquisition prerequisite: the User supplies the Race recording, Chassis Notes stores it privately in R2, and Cloudflare prepares the owned source into the immutable Track-view artifact consumed by the local GPU worker.

## Private GPU host operations

The local execution boundary described by ADR 0028 is operated with the
repository-owned assets in `services/driving-analysis-gpu/ops/`. A root-owned
systemd service runs the capacity-one Docker worker with a loopback-only
FastAPI listener, read-only model/profile mounts, dropped capabilities, bounded
tmpfs, and an encrypted UID/GID 10001 state volume. A separate least-privilege
`cloudflared` service exposes only the private hostname ingress and a default
deny route. Access service authentication remains exclusively in the trusted
Worker; neither service receives application, D1, Workflow, Durable Object, or
R2-signing credentials.

Startup preflight checks the Docker/NVIDIA runtime, storage encryption and
permissions, profile/checkpoint digest agreement, required mounts, and safe
container flags. The worker persists terminal timestamps, prunes only expired
terminal workspaces, protects active and valid `output-ready` work, and emits
safe lifecycle telemetry without grant URLs, credentials, media, provider
responses, hostnames, or machine identifiers. Unfinished work is interrupted
on restart or watchdog expiry and must be reauthorized by Cloudflare.
