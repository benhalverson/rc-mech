# Driving analysis

## Goal

Give a User an evidence-based review of one Subject car's corner entry and exit during a completed race. Chassis Notes owns this capability as a new implementation; the earlier `rc-racing-line-analysis` project is reference material only, and none of its code or contracts are reused.

## Accepted version-one workflow

1. The User selects a Race recording from their device. Chassis Notes uploads it in authenticated resumable parts to private R2 storage and validates the completed media before analysis.
2. Chassis Notes plays the private Race recording with its own video player.
3. The User scrubs the recording and marks the start and end timestamps of the Race window.
4. Chassis Notes analyzes only the Race window and only the fixed Track view in the bottom two-thirds of the recording. The three smaller upper panels and broadcast graphics are ignored.
5. The Driving analysis uses a reviewed Track map created once for the visible Track layout. Each corner has a drawn entry Corner gate, exit Corner gate, and rectangular Corner view; the map is reused by races on that layout instead of being rediscovered by a model.
6. The User selects one existing Drive session and its Car, pauses near the race start, and draws a bounding box around that Car to establish its Subject-car identity. The completed Driving analysis belongs to that Drive session.
7. One Driving analysis follows only that Subject car. A different car in the same Race window requires a separate analysis attached to that car's Garage record.
8. A Corner pass begins when the Subject car's center crosses the entry Corner gate and ends when it crosses the exit Corner gate.
9. A Corner pass is eligible only when the tracker maintains an unambiguous Subject-car identity throughout the gate-to-gate interval. Chassis Notes excludes uncertain, occluded, or possibly identity-switched traversals instead of interpolating or guessing.
10. Uncertain identity creates a Tracking gap. The User performs Re-identification by drawing a new box around the Subject car at the first clear frame after the gap; tracking resumes from that frame without filling the gap.
11. Re-identification reruns affected corner comparisons, but a traversal overlapping the Tracking gap remains ineligible.
12. For each corner, Chassis Notes compares the Subject car's eligible Corner passes. The pass with the shortest observed traversal time is the Best corner pass; Chassis Notes does not generate or predict a theoretically ideal line.
13. Chassis Notes spatially crops each Corner clip to that corner's fixed Corner view. The clip starts 0.5 seconds before the entry-gate crossing and ends 0.5 seconds after the exit-gate crossing, but traversal time remains the unpadded gate-to-gate interval.
14. Chassis Notes retains a Corner clip for every eligible Corner pass and labels the Best corner pass. The User can review all passes used in the comparison.

The User must have permission to upload and process the Race recording. Chassis Notes does not fetch media from third-party URLs.

The version-one supported source guarantees that the main static camera does not move or zoom and that the broadcast framing remains fixed. Track-map versions therefore represent changes to the Track layout or its reviewed corner geometry, not alternate camera positions.

## Processing lifecycle

- Creating a Driving analysis immediately returns its stable analysis identifier; it does not hold the HTTP request open until video work finishes.
- The analysis reports queued, running, awaiting-reidentification, completed, failed, and cancelled states with a current stage and progress suitable for the UI.
- Upload validation, Race-window extraction, Subject-car tracking, gate-crossing measurement, and Corner-clip rendering are separate resumable stages.
- One Tracking segment starts from the initial Subject seed or one Re-identification and ends at Race-window completion, the first Tracking gap, cancellation, or terminal provider failure. Infrastructure retry reuses the same immutable segment; Re-identification creates another segment in the same run.
- A Tracking gap successfully completes the current segment with observations through the last trusted point. Only after Cloudflare accepts that immutable artifact does the analysis publish `awaiting-reidentification`; the GPU is released and never waits for User input.
- A ready segment may wait for provider availability or capacity for up to 24 hours. Before Tracking begins this is public `queued`; after accepted Tracking evidence exists the run remains public `running` at `tracking` and never regresses to `queued`.
- Public progress is monotonic within one run and remains below 100 percent until the authoritative completion commit. Internal download, transfer, retry, lease, and recovery states do not expand the public lifecycle.
- Retried stages are idempotent and may replace only their own incomplete artifacts. Previously reviewed evidence is not silently duplicated or reinterpreted.

## Runtime boundary

- The existing TypeScript Worker owns authentication, Garage and Drive-session ownership, validation, API contracts, orchestration commands, persistence metadata, and authorization of stored artifacts.
- One Cloudflare Workflow orchestrates each immutable run, while D1 remains authoritative for the public lifecycle and accepted evidence. A singleton Durable Object coordinates FIFO access to the one physical GPU but owns no analysis state or evidence.
- A stateless Cloudflare Python container owns media probing, FFmpeg Race-window/Track-view preparation, frame manifests, and Corner-clip rendering. It has no general Internet access and does not proxy GPU control.
- The versioned `TrackingProvider` boundary lives in trusted TypeScript. The initial provider calls an Access-protected local FastAPI service through Cloudflare Tunnel, where SAM 3.1 runs one continuous segment at a time on the Owner's RTX 3090.
- The TypeScript layer determines evidence eligibility and the Best corner pass from validated observations. Neither Python service redefines Track maps, selects a different Subject car, owns User-facing lifecycle, or publishes results directly into Garage history.
- The local worker has no application, D1, Workflow, Durable Object, R2-signing, or Access credential. It transfers prepared media and compact artifacts only through short-lived execution-specific grants issued after Cloudflare acquires and activates a fenced GPU lease.
- Large temporary media files belong to the processing runtime or private object storage, never D1. Durable relational records retain identifiers, state, measurements, provenance, and artifact references.

## Inference portability

- Trusted TypeScript depends on a versioned `TrackingProvider` interface rather than a specific hosting location. Strict shared Zod and Pydantic fixtures keep segment, status, observation, transfer, and artifact contracts portable across providers.
- Every run pins one immutable Inference profile containing only inference-affecting provider, model, runtime, pipeline, preprocessing, precision, confidence-calibration, threshold, prompt, and tracking configuration. A versioned canonicalization scheme produces its digest.
- The run, every submission, the worker's resolved configuration, every status, and every accepted artifact must carry the same Inference-profile digest. Lease, attempt, timing, host, driver, and hardware observations remain attempt metadata outside that digest.
- Re-identification changes only the next segment's seed. It never changes the run's Inference profile.
- If the chosen provider or exact profile becomes unavailable after the run starts, the run waits, retries, fails retryably, or is cancelled. It never migrates silently.
- Selecting another provider or profile creates a new run and Workflow. The new run may reuse immutable source inputs but regenerates all Tracking evidence instead of combining observations from the earlier profile.
- Version one's production provider is `LocalSam31Provider` through `gpu.chassisnotes.com`; future managed-GPU providers implement the same TypeScript contract and can be selected only before a run is created.

## Evidence boundary

- An inference provider emits timestamped Subject observations containing the car's visible position, identity confidence, visibility or occlusion state, and provider provenance.
- The provider does not define corners, detect a "best" line, assign coaching scores, or rank Corner passes.
- Tracking is tuned for identity precision rather than maximum coverage. When identity confidence falls below the accepted threshold, the pipeline opens a Tracking gap immediately instead of continuing with a likely guess.
- False gaps are preferable to silent identity switches: a User can repair a gap through Re-identification, while evidence attributed to the wrong car is invalid.
- Only `race-window-complete` and `tracking-gap` segment outcomes can produce accepted Subject observations. Partial output from cancelled, interrupted, stale, or provider-failed attempts is diagnostic only and never becomes evidence.
- Versioned deterministic code validates observation continuity, detects center crossings of reviewed Corner gates, computes gate-to-gate time, applies eligibility rules, and ranks eligible Corner passes.
- The same retained Subject observations and Track-map version produce the same measurements and ranking under the same deterministic pipeline version.

## Model benchmark

- The exact provider, model, and Inference profile are not accepted from a demo clip or architecture claim; they must pass a manually annotated representative-footage benchmark.
- The initial benchmark contains at least three complete Race windows from the supported fixed camera.
- The corpus uses different Subject cars and includes differing field density, similar-looking competitors, occlusions, and moments that require or nearly require Re-identification.
- Ground truth identifies the Subject car, known ambiguous spans, and corner-gate crossings needed to evaluate observation identity, coverage, and timing.
- Benchmark fixtures and expected outcomes are versioned so a provider, model, or threshold change can be compared with the same evidence.
- A release candidate must produce zero unflagged identity switches across the complete benchmark. Any possible switch must open a Tracking gap at or before the first frame whose identity is not trustworthy.
- Identity integrity is release-blocking and is evaluated independently from coverage; greater coverage cannot compensate for a silent switch.
- Before any User Re-identification, at least 80% of ground-truth Corner passes across the benchmark must be emitted as eligible Corner passes.
- Coverage is measured at the Corner-pass level, not merely by the percentage of frames containing a box, because reviewable corner evidence is the product outcome.

## Track-map governance

- Track maps are shared reference data, not User-owned Garage records.
- Only the Chassis Notes Owner can create, edit, approve, or retire a Track map.
- Users can inspect and select an approved Track map but cannot alter its Corner gates or Corner views.
- A Driving analysis cannot start against an unapproved or retired Track map.
- Approving an edit publishes a new immutable Track-map version; it never mutates an approved version.
- Each Driving analysis pins the exact Track-map version it used. Later approvals do not recalculate old Corner passes or change an old Best corner pass.
