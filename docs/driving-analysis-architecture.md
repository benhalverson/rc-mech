# Driving analysis API architecture

**Status:** proposed implementation plan

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
        |---------------------> D1 metadata and lifecycle
        |<-- browser parts ----> private ANALYSIS_MEDIA R2 binding
        |-- upload complete ---> RaceVideoValidationWorkflow ---> named container
        `-- analysis create ---> DrivingAnalysisWorkflow -------> named container

named DrivingAnalysisContainer instances
        |---------------------> container-hosted inference provider
        `-- analysis-media.internal --> Worker outbound handler --> private R2
```

There is no second public API origin. The existing Worker remains the same-origin API and Angular host under ADR 0001. The Python service is reachable only through its container Durable Object binding.

## Responsibilities

| Boundary | Owns | Must not own |
| --- | --- | --- |
| Angular feature | Resumable upload, private video player, Race-window selection, Subject-car box, progress, Re-identification, pass review, accessibility | R2 keys, multipart identifiers, direct persistence, model calls |
| NgRx Signal Store | Creation commands, analysis state, polling lifecycle, cancellation, correction outcomes | DOM coordinates, player handles, endpoint parsing |
| Feature gateway | API URLs, `httpResource` reads, cold mutation Observables, Zod parsing | User-interface state or workflow decisions |
| Hono routes | Authentication, Owner/User authorization, request validation, resource ownership, public DTOs | FFmpeg, model invocation, long-running orchestration |
| Domain rules | State transitions, normalized geometry validation, observation continuity, gate crossing, pass eligibility, ties and ranking | Network, D1, R2, container lifecycle |
| Cloudflare Workflow | Durable stage sequencing, retry policy, waiting for Re-identification, cancellation checkpoints | Long-lived application state or large binary artifacts |
| Python container | Media probing, accurate trimming, Track-view crop, inference, observation serialization, clip rendering | Garage ownership, Track-map edits, ranking, publishing results directly |
| D1 | Durable metadata, versions, state, measurements, provenance, artifact references | Video bytes, frame images, model files |
| private R2 | Uploaded Race recordings, temporary Race-window media, retained observations, Corner clips and integrity metadata | Public unauthenticated media |

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

Race-video validation uses `probing` and `decode-validation` stages before an analysis exists. Driving-analysis stages are `preparation`, `tracking`, `measurement`, `clip-rendering`, and `finalization`. Analysis progress is monotonic within one run but may reset when a new run starts. D1 is authoritative because completed Workflow state has platform retention limits.

Failures use stable public codes:

- `VIDEO_NOT_READY`
- `VIDEO_INVALID`
- `VIDEO_UNAVAILABLE`
- `UPLOAD_INCOMPLETE`
- `INVALID_RACE_WINDOW`
- `UNSUPPORTED_VIDEO_LAYOUT`
- `TRACK_MAP_UNAVAILABLE`
- `SUBJECT_NOT_FOUND`
- `MODEL_FAILED`
- `ARTIFACT_WRITE_FAILED`
- `RESOURCE_LIMIT_EXCEEDED`
- `PROCESSING_FAILED`

Provider exception text, credentials, media URLs, prompts, and response bodies are not returned or persisted as public errors.

## Workflow stages

1. **Validate video and ownership** — reload the ready Race-video object, its R2 metadata, every parent record, Track-map version, and command idempotency key.
2. **Prepare Race window** — the named container reads the uploaded recording through the constrained R2 handler, decodes only the selected interval, crops the fixed Track view, and writes a working MP4 plus checksum to private R2.
3. **Track Subject car** — the provider begins at the User seed or latest Re-identification and writes compressed Subject observations to R2. It stops at the first ambiguous identity.
4. **Wait for Re-identification when required** — persist the Tracking gap, publish `awaiting-reidentification`, and use `step.waitForEvent`. Waiting consumes no container and the ephemeral disk may disappear.
5. **Resume tracking** — reacquire the working segment from R2, append a new immutable observation segment, and repeat until the Race window ends.
6. **Measure** — TypeScript deterministic rules validate continuity, interpolate gate crossings, construct eligible Corner passes, apply tie rules, and persist measurements transactionally.
7. **Render clips** — the container receives only validated clip specifications, crops each Corner view, adds unobtrusive Subject-center and gate overlays, and writes browser-compatible H.264 MP4 clips without audio.
8. **Finalize** — verify R2 checksums and sizes, rank passes per corner, publish `completed`, and schedule deletion of the working Race-window object.

Each stage is idempotent on `(runId, stage, inputDigest)`. A retry either returns the already verified output or writes a new attempt key and atomically promotes it. Workflow step outputs contain small descriptors, never video or full observation arrays.

## Python container contract

The service lives at `containers/driving-analysis/`, listens on one internal port, and exposes only versioned stage endpoints:

| Method | Internal path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Process and model readiness. |
| `POST` | `/v1/media/probe` | Probe and bounded-decode a completed upload before it can become ready. |
| `POST` | `/v1/stages/prepare` | Read the owned Race recording through the R2 handler, trim, crop, and store working media. |
| `POST` | `/v1/stages/track` | Run one continuous trusted tracking segment from a supplied seed. |
| `POST` | `/v1/stages/render` | Render an immutable list of validated Corner-clip specifications. |

Requests and responses use strict Pydantic models with `additionalProperties` rejected. The Worker parses responses with corresponding Zod schemas. A shared set of JSON fixtures proves both sides accept and reject the same contract.

A Subject observation contains:

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

## Persistence model

The exact migration can evolve during implementation, but these ownership and immutability boundaries are required.

| Record | Important fields and relationships |
| --- | --- |
| `race_video` | owner, Car, Drive session, server-generated R2 key, display filename/type, declared/actual size, upload ID, status, validated media metadata, timestamps |
| `race_video_upload_part` | Race video, part number, ETag, byte count, completed timestamp; unique per video and part number |
| `track_layout` | stable layout identity, venue/name, active/retired state |
| `track_map_version` | layout ID, integer version, draft/approved/retired state, reference source metadata, creator, approval timestamp |
| `track_corner` | map-version ID, stable corner key, order, name, entry/exit gate coordinates, Corner-view coordinates |
| `driving_analysis` | owner, Car, Drive session, Race-video ID, Race window, pinned map version, seed, status/stage/progress, current run, Workflow ID, timestamps |
| `driving_analysis_request` | owner and client request ID, request digest, analysis ID, outcome; prevents duplicate jobs |
| `driving_analysis_run` | sequence, provider/model/image/pipeline/config provenance, status, input digest, started/completed timestamps |
| `subject_observation_artifact` | run, segment order, R2 reference, checksum, byte count, first/last timestamps |
| `tracking_gap` | run, start timestamp, reason code, correction state |
| `reidentification` | gap, client command ID, User, timestamp, normalized box, created timestamp; append-only |
| `corner_pass` | run, corner, ordinal, crossing timestamps/frame pairs, duration, eligibility/exclusion, rank and tie group |
| `analysis_artifact` | owner, analysis/run, kind, private R2 key, content type, byte count, checksum, retention/deletion timestamps |

Approved Track-map versions, Re-identifications, completed run provenance, and measured Corner passes are immutable. A rerun creates new run records and promotes one run as current without deleting prior evidence.

## Private media and retention

- Add a separate private R2 bucket and Worker binding named `ANALYSIS_MEDIA`; do not mix multi-megabyte analysis artifacts into the compatibility-sensitive `PHOTOS` bucket.
- Use owner/Drive/video prefixes for uploads and owner/analysis/run prefixes for derived artifacts. Every key is opaque, server-generated, never accepted from a client, and never returned in public DTOs.
- Uploaded Race recordings remain private and reusable by analyses for the same Drive session until the User deletes them. Deletion is refused while an analysis is active; completed analyses retain their derived evidence but cannot be retried after their source recording is deleted.
- Incomplete multipart uploads expire and are aborted automatically. Their D1 upload-part records are then deleted.
- Working Race-window media is retained while a run is active or awaiting Re-identification, then deleted within 24 hours after completion, cancellation, or terminal failure.
- Compressed Subject observations and every eligible Corner clip remain until the User deletes the Driving analysis. These are the retained provenance needed to explain a result.
- Do not retain extracted full frames, model masks, or debug video by default.
- Deletion is idempotent and recoverable only while R2 object deletion has not completed. The UI must state when deletion becomes permanent.
- Artifact reads go through the authenticated Worker with ownership checks and byte-range support. The bucket has no `r2.dev` or custom-domain public access.

## Container isolation

- Use one named container instance per validation or processing run, addressed by its validation/run ID; do not randomly load-balance stateful stage requests.
- Start benchmarking with `standard-4` because it is the largest standard CPU instance, then downsize only if the representative benchmark still passes quality and processing targets. Start with `max_instances: 2` to bound platform spend.
- The image is `linux/amd64`, pinned by digest in run provenance, and contains FFmpeg, Python, the selected optimized model, and no development tools.
- Set `enableInternet = false` in production. Export `ContainerProxy` and allow only explicit virtual hosts.
- `analysis-media.internal` is an `outboundByHost` Worker handler that validates the container/run identity and translates constrained HTTP range reads and writes into the `ANALYSIS_MEDIA` R2 binding.
- A later Workers AI provider uses a separate outbound handler so the Worker keeps the binding and credentials; it does not broaden general internet access.
- Container disk is scratch space only. Every stage must tolerate a fresh disk after sleep or rollout.

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
- Use strict duration, coordinate, corner-count, clip-count, and object-size limits. Reject nonfinite coordinates and degenerate gates/views.
- Do not construct shell command strings from requests. Invoke FFmpeg with argument arrays and validated local paths.
- Never log upload bodies, video frames, model inputs, Subject boxes, internal media URLs, multipart identifiers, or R2 object bodies.
- Redact container/provider exception text before it reaches D1 or clients. Structured internal logs retain only safe error class and stage.
- Enforce per-file, retained-storage, incomplete-upload, and active-analysis quotas per User. Rate-limit upload creation and analysis creation without throttling legitimate authenticated part transfer.
- Cancellation and deletion are ownership-checked commands, not direct Workflow or R2 identifiers supplied by the browser.

## Local development

- Use the same Dockerfile and Python stage contract locally and in Cloudflare.
- `wrangler dev` runs the container through local Docker and supports the same outbound-handler shape.
- `INFERENCE_PROVIDER=local-http` points the Python adapter at the developer's local model; production uses `container-model`. Both must pass the same contract fixtures.
- Automated tests upload a tiny licensed/synthetic fixture through the multipart API and use fake inference observations plus local R2 doubles. They never contact Workers AI, production D1/R2, or the deployed Worker.
- A manual benchmark command resolves private benchmark objects, runs the selected provider, and writes a report without committing race recordings to Git.
- Record Docker image digest, Python lockfile hash, FFmpeg version, model hash, and pipeline version in every benchmark report.

## Observability

Every safe log and metric carries `analysisId`, `runId`, `stage`, and `attempt`; container logs additionally carry the container Durable Object ID.

Track:

- stage wall time, active container time, retries, cold starts, and terminal errors;
- Race-window duration, decoded frame count, observation count, gap count and duration;
- eligible/ground-truth Corner-pass coverage in benchmarks;
- identity-switch benchmark failures as a separate release-blocking measure;
- gate-timing error distribution, clip count, R2 bytes written/deleted, and retained bytes per analysis;
- provider/model/image/pipeline versions and cost attribution.

D1 state, not logs or the Workflow dashboard, supports the User-facing progress view.

## Verification

### TypeScript

- Pure tests cover multipart state, size/part validation, normalized geometry, finite gate intersection, direction, timestamp interpolation, gap overlap, eligibility, tie handling, ranking, state transitions, idempotency, and retention rules.
- Hono tests call public `app.request(path, init, MOCK_ENV)` with typed D1, R2, Workflow, and container doubles. No test loads live Wrangler bindings or remote services.
- Workflow tests prove completed steps are not repeated, retryable and nonretryable errors diverge correctly, waiting/resume behavior is idempotent, cancellation fences late completions, and a stale run cannot become current.
- Ownership tests cover another User's analysis, Drive session, clips, request IDs, and correction IDs; Track-map mutations require the configured Owner.

### Python

- Pytest unit tests cover strict request models, FFmpeg argument construction, accurate trimming, Track-view and Corner-view pixel conversion, observation serialization, and safe error mapping.
- Fixture-video integration tests run real FFmpeg and a fake inference provider through probe, prepare, track, and render endpoints.
- Contract tests share accepted and rejected JSON fixtures with the TypeScript Zod schemas.
- The representative benchmark contains at least three complete Race windows, produces zero unflagged identity switches, and automatically emits at least 80% of ground-truth Corner passes as eligible.

### Angular and browser

- Component, store, gateway, and pure-rule tests remain colocated and satisfy the configured 100% per-file coverage gate.
- Playwright uses the production Angular build, local Worker, fake processing provider, and synthetic fixture to cover resumable upload, exact Race window, keyboard/pointer Subject selection, progress, Re-identification, all-pass review, ties, cancellation, deletion, and AXE.
- A browser smoke uploads and plays an owned fixture through the real deployed private-R2 path without placing production media in CI.

## Delivery slices

Each slice should be independently reviewable and keep tests green before the next begins.

1. **Benchmark harness and fixture contract** — establish manual annotations, shared observation schema, candidate provider adapters, and the zero-switch/80%-coverage report before selecting a model.
2. **Track-map domain and Owner authorization** — migrations, pure geometry rules, Owner-only Hono APIs, immutable approval/versioning, and focused tests.
3. **Race-video upload API** — migrations, authenticated multipart create/part/complete/abort routes, D1 resume state, quotas, validation lifecycle, private range playback, OpenAPI, and ownership tests.
4. **Workflow skeleton** — durable stages, D1 progress, retry/cancel fencing, wait-for-event Re-identification, and a fake container port.
5. **Python media service** — container scaffold, health, probe, and prepare endpoints, FFmpeg validation/trim/crop, outbound R2 handler, synthetic fixture integration, and image hardening.
6. **Local inference provider** — Subject seed, observation contract, confidence/gap behavior, benchmark integration, and no ranking in the model service.
7. **Deterministic evidence engine** — continuity, gate crossings, pass eligibility, ties/ranking, D1 writes, and rerun provenance.
8. **Clip rendering and private playback** — Corner-view/padding render requests, H.264 output, R2 retention/deletion, authenticated range streaming, and ownership tests.
9. **Angular creation and correction workflow** — lazy route, gateway/store, resumable upload, private video player, Race-window editor, accessible Subject boxing, progress polling, and Re-identification.
10. **Angular evidence review** — per-corner pass comparison, Best/tie labels, clips, gaps/exclusions, provenance, deletion, Playwright, and AXE.
11. **Production container provider** — benchmark-selected optimized model, `standard-4` deployment baseline, constrained egress, observability, cost measurements, and private-source smoke.
12. **Release hardening** — full backend/client/architecture/browser coverage, dry-run deploy, Container rollout verification, R2 privacy checks, production migration check, and failure/cancellation drills.

## Completion contract

Version one is complete only when:

- every accepted workflow rule in `docs/specs/driving-analysis.md` is exposed through the authenticated API and accessible UI;
- the production model passes zero unflagged identity switches and at least 80% automatic Corner-pass coverage on the versioned benchmark;
- old Track-map versions and old processing runs remain reproducible and unchanged;
- no client-controlled R2 key, arbitrary URL fetch, public R2 object, broad container egress, remote automated test, or raw provider error remains;
- cancellation, retries, Re-identification, container restart, Workflow replay, and artifact deletion are idempotent;
- the full repository lint, format, TypeScript, backend coverage, Angular 100% per-file coverage, production build, Playwright, AXE, dry-run deploy, and relevant production acceptance checks pass.

Version one has no external media-acquisition prerequisite: the User supplies the Race recording, Chassis Notes stores it privately in R2, and the same owned object feeds local or Cloudflare processing.
