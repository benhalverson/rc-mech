# Offline trackside use

## Problem Statement

Many indoor RC tracks have weak cellular reception and no usable Wi-Fi. A Racer
may sign in before entering the building but then lose connectivity for several
hours while they need Chassis Notes most. The current application depends on
live HTTP for protected-route access, reads, and nearly every mutation; only new
voice captures have a narrow IndexedDB queue.

Chassis Notes must remain useful through a temporary trackside outage without
pretending that remote work completed or turning temporary offline use into a
second long-term authentication system.

## Solution

Make the authenticated garage local-first after one successful online sign-in
and synchronization. Chassis Notes prepares the application shell, all
structured garage records, and media metadata on the device, then reports
**Offline ready**. Every garage action is retained in durable local state first
and synchronized in the background whether reception is strong, intermittent,
or absent.

During an **Offline session**, previously synchronized records remain
available, new work survives browser restarts, and remote-dependent work is
shown as **Pending sync**. Synchronization resumes automatically when the
service becomes reachable. Rejected work becomes **Needs attention**, and
incompatible remote changes become a **Sync conflict** instead of being lost or
silently overwritten.

## User Stories

1. As a User, I want Chassis Notes to prepare offline data automatically after I sign in, so that I do not need to remember a manual download step.
2. As a User, I want a clear Offline ready status, so that I know the garage will remain available before I enter a track with poor reception.
3. As a User, I want offline use from a normal browser, so that home-screen installation remains optional.
4. As a User, I want Chassis Notes to detect an outage automatically, so that I do not need to switch modes at the track.
5. As a User, I want a small persistent offline status, so that I understand why remote work is waiting without having my workflow interrupted.
6. As a User, I want to close and reopen the browser while offline, so that an accidental tab close or phone restart does not end my trackside work.
7. As a User, I want to browse my synchronized cars, builds, setups, drive sessions, maintenance, photos, and voice notes offline, so that garage history remains useful inside the track.
8. As a User, I want every garage action retained locally first, so that weak reception never makes a form hang or lose my work.
9. As a User, I want offline work labeled Pending sync, so that local retention is not confused with remote completion.
10. As a User, I want new trackside photos and voice recordings retained on my device, so that media capture is safe without reception.
11. As a User, I want media I view or explicitly keep offline to remain available during an outage, so that initial synchronization does not download every large original automatically.
12. As a User, I want voice capture to work offline, so that transcription and draft extraction can resume later without losing the original observation.
13. As a User, I want synchronization to resume automatically when connectivity returns, so that leaving the track requires no cleanup ritual.
14. As a User, I want successful synchronization to clear Pending sync state, so that I can tell which work reached Chassis Notes.
15. As a User, I want rejected work retained as Needs attention, so that server validation never silently discards trackside work.
16. As a User, I want one rejected item not to block unrelated synchronization, so that the rest of the race day can still be saved.
17. As a User, I want incompatible device changes preserved as a Sync conflict, so that Chassis Notes never silently chooses the last writer.
18. As a User, I want explicit sign-out to remove my cached garage and Offline media, so that private data does not remain available to the next person using the device.
19. As a User, I want a warning before sign-out deletes Pending sync work, so that I do not destroy unsynchronized records accidentally.
20. As a User without the required browser capabilities, I want an honest online-only explanation, so that Chassis Notes does not claim offline readiness it cannot provide.
21. As a User of assistive technology, I want offline, synchronization, conflict, and failure states announced accessibly without stealing focus, so that trackside status remains understandable.

## Product Contract

- Offline use addresses temporary loss of reception during a track visit, not indefinite disconnected-account access.
- The User must complete an online sign-in and initial synchronization before the device can become Offline ready.
- Offline support is based on Service Worker, IndexedDB, and Cache Storage capability detection rather than a named browser list.
- Home-screen installation is optional and does not change the offline contract.
- All structured garage records and media metadata are included in initial synchronization.
- Existing media originals are cached when viewed or explicitly kept offline. New media captures remain local until synchronized.
- Every garage action writes durable local state first and follows one background synchronization path regardless of apparent connectivity.
- The app shell, lazy feature code, and required static assets remain launchable after the browser is closed and reopened offline.
- The interface shows a persistent, non-blocking “Offline—changes will sync later” status during an outage.
- Local success means retained on this device. Remote success is shown only after server acknowledgement.
- Reconnection starts synchronization automatically. A manual mode switch is never required.
- Append-only and non-overlapping work may merge automatically. Incompatible changes retain both versions for User review.
- A rejected operation remains recoverable as Needs attention and does not block independent queued work.
- Explicit sign-out clears the User's local garage and Offline media. Pending sync work requires destructive confirmation before removal.

## Implementation Decisions

- Add a Service Worker that installs the complete versioned application shell, including lazy route bundles required by authenticated features.
- Add application-wide offline infrastructure behind root-provided capability services. Components must not access IndexedDB, Cache Storage, Service Worker APIs, or connectivity globals directly.
- Keep feature components, route-provided workflow stores, and feature gateways within the accepted Angular boundaries. Stores issue feature commands and render typed local/synchronization outcomes; gateways retain ownership of HTTP contracts and Zod parsing.
- Use one owner-scoped local database for synchronized records, queued operations, media metadata, and durable media captures. Integrate the existing voice queue into the shared offline lifecycle rather than creating unrelated queues per route.
- Give every local operation a stable identity and make remote application idempotent so retries cannot create duplicate cars, setups, drive sessions, maintenance records, photos, invites, or voice notes.
- Preserve dependency order for related offline work, such as creating a car before synchronizing its setup or drive session, without blocking independent operations.
- Track server versions or equivalent concurrency evidence for mutable records. Never resolve incompatible changes with silent last-write-wins.
- Treat actual request success and failure as connectivity evidence; `navigator.onLine` alone is not authoritative on weak indoor networks.
- Keep the server as the durable cross-device record after synchronization while the local database acts as the device's immediate working copy.
- Preserve existing backend routes and user-facing contracts where practical. Add synchronization, idempotency, and concurrency contracts without changing garage ownership or exposing private records.
- Keep Worker port `8787`, Angular development port `4200`, and existing browser-test infrastructure unchanged.

## Deferred and Unavailable Operations

- Voice recording and text capture work offline. Cloudflare transcription, structured draft extraction, correction processing, and confirmation requiring remote state wait for connectivity.
- A setup import may continue from a source already represented in synchronized local data, but a new uncached external setup URL cannot be fetched offline.
- Passkey registration, rename, and revocation remain unavailable offline because they require a live credential ceremony or authenticated server mutation.
- Other remotely constrained commands may be retained as Pending sync and can become Needs attention if the server rejects them after reconnection.

## Testing Decisions

- Make the primary browser acceptance start with online sign-in and Offline ready, switch the browser context offline, close and reopen the page, exercise authenticated garage routes, restore connectivity, and verify automatic synchronization.
- Split browser coverage into focused workflows so no individual test is allowed to run for 30 seconds or longer.
- Verify offline reads and local-first writes for cars, builds, current setup and setup history, drive sessions, maintenance plans, service records, consumables, photos, and voice capture.
- Verify app-shell and lazy-route loading from a cold reopened tab with the network disabled and without requiring home-screen installation.
- Verify new photos and voice recordings survive restart, while uncached existing media is identified honestly as unavailable.
- Verify intermittent request failures do not lose input, duplicate operations, reorder dependent work, or cause the interface to oscillate incorrectly.
- Verify idempotent retry, automatic reconnection, independent queue progress, Needs attention retention, and Sync conflict review.
- Verify explicit sign-out removes local records and media and requires destructive confirmation when Pending sync work exists.
- Verify missing Service Worker, IndexedDB, or Cache Storage capability produces an accessible online-only explanation and never reports Offline ready.
- Verify status changes through rendered behavior and AXE: Preparing, Offline ready, Offline, Pending sync, Syncing, Needs attention, and Sync conflict.
- Add focused service-worker, local-database, sync-coordinator, feature-store, gateway, and pure conflict-rule tests while preserving the configured 100 percent per-file Angular coverage gate.
- Run the repository's standard lint, format, architecture, typecheck, backend, client, Worker dry-run, browser, AXE, and diff checks.

## Out of Scope

- First-time registration, magic-link redemption, or sign-in without connectivity.
- Long-term disconnected-account access or a separate offline authorization lifecycle.
- Browser-hosted Whisper or local draft-extraction models.
- Offline passkey administration.
- Fetching an uncached external setup source.
- Automatically downloading every full-resolution photo and original voice recording during initial synchronization.
- Requiring PWA or home-screen installation.
- A named browser support matrix beyond required-capability detection.
- Shared garages, collaboration, or changes to User ownership boundaries.

## Acceptance Scenario

A User signs in online and waits for Offline ready. The User enables airplane
mode, closes and reopens the browser, navigates the synchronized garage,
completes every garage and trackside workflow, and captures photos and voice
notes. All new work survives restarts and appears as Pending sync. When
connectivity returns, synchronization resumes automatically; acknowledged work
becomes synchronized, rejected work remains Needs attention, and incompatible
changes remain available for conflict review. Passkey administration, uncached
external imports, and remote voice processing remain unavailable until the
service can be reached.

## Further Notes

The accepted architectural boundary is recorded in
[ADR 0015](../adr/0015-offline-garage-work-after-initial-sync.md), and the
canonical language is recorded in [`CONTEXT.md`](../../CONTEXT.md). Delivery
should proceed as dependency-ordered vertical slices that each prove local
read, local write, synchronization, recovery, accessibility, and browser
behavior rather than as separate database, API, and interface phases.
