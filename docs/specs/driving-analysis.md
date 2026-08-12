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
- A Tracking gap pauses the evidence path at an awaiting-reidentification state until the User supplies Re-identification; completed stages are not repeated unnecessarily.
- Retried stages are idempotent and may replace only their own incomplete artifacts. Previously reviewed evidence is not silently duplicated or reinterpreted.

## Runtime boundary

- The existing TypeScript Worker owns authentication, Garage and Drive-session ownership, validation, API contracts, durable workflow state, persistence metadata, and authorization of stored artifacts.
- A Python container service owns media probing, FFmpeg extraction and rendering, computer-vision tracking, and gate-crossing observations.
- The TypeScript layer determines evidence eligibility and the Best corner pass from validated observations. The Python service does not redefine Track maps, select a different Subject car, or publish results directly into Garage history.
- Large temporary media files belong to the processing runtime or private object storage, never D1. Durable relational records retain identifiers, state, measurements, provenance, and artifact references.

## Inference portability

- The Python service depends on a versioned inference-provider interface rather than a specific model runtime.
- Local development and Cloudflare deployment use the same pipeline inputs, observations, confidence representation, and error contract.
- Local development may call a model running on the developer's machine. Cloudflare deployment may call Workers AI or a model packaged in a Cloudflare Container.
- Every processing run records the provider, model identifier, model version or immutable image digest, pipeline version, and configuration needed to explain and reproduce its observations.
- Changing a provider or model creates a new processing run. It does not overwrite the provenance of retained Corner passes or clips.
- The first Cloudflare production provider packages its model and inference runtime in the Python container. The exact model is selected through representative-footage benchmarks rather than architecture preference.
- Workers AI remains a supported future provider shape, but it is not the version-one production dependency unless a later benchmark demonstrates equivalent Subject-observation quality.

## Evidence boundary

- An inference provider emits timestamped Subject observations containing the car's visible position, identity confidence, visibility or occlusion state, and provider provenance.
- The provider does not define corners, detect a "best" line, assign coaching scores, or rank Corner passes.
- Tracking is tuned for identity precision rather than maximum coverage. When identity confidence falls below the accepted threshold, the pipeline opens a Tracking gap immediately instead of continuing with a likely guess.
- False gaps are preferable to silent identity switches: a User can repair a gap through Re-identification, while evidence attributed to the wrong car is invalid.
- Versioned deterministic code validates observation continuity, detects center crossings of reviewed Corner gates, computes gate-to-gate time, applies eligibility rules, and ranks eligible Corner passes.
- The same retained Subject observations and Track-map version produce the same measurements and ranking under the same deterministic pipeline version.

## Model benchmark

- The exact local or container-hosted model is not accepted from a demo clip or architecture claim; it must pass a manually annotated representative-footage benchmark.
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
