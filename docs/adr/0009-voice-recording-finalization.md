# ADR 0009: Finalize voice recordings as one browser MediaRecorder blob

- Status: Accepted
- Date: 2026-08-08

## Context

The voice track log does not need streaming audio chunks. It uploads a private
recording after the user presses Stop. One-second `MediaRecorder` timeslices
produced fragmented WebM output with unreliable duration metadata and packet
gaps near the end of recordings.

## Decision

Use the browser's native `MediaRecorder` and call `start()` without a
timeslice. Collect `dataavailable` events and construct the upload blob only
after the final `dataavailable` event and `stop` event. Negotiate the MIME type
from the browser's supported types, preferring Opus WebM.

Keep recording state and microphone-level state in the NgRx Signal Store used
by the `VoiceRecorder` service. The service owns the recorder, stream, Web
Audio analyser, event listeners, timers, and cleanup. The component only binds
to the service's read-only signals and invokes its operations.

The analyser is connected to the media stream source but not to the audio
destination, so microphone monitoring is not enabled. A recording must exceed
-50 dBFS for at least 150 ms before it can be uploaded.

## Alternatives considered

### Keep `extendable-media-recorder`

This preserves its broader encoding abstraction, but retains unnecessary
encoder and chunking complexity for a non-streaming workflow and does not
address the fragmented final WebM behavior.

### Use native `requestData()` boundaries

This still creates multiple media segments and leaves container finalization
and packet-boundary behavior to the browser. It does not provide a benefit for
this upload-after-stop workflow.

### Encode PCM/WAV through Web Audio

This gives deterministic container output, but requires custom buffering and
encoding, produces larger recordings, and adds more browser-specific resource
management than this feature needs.

### Add another recording library

An additional library would add maintenance and bundle cost without removing
the need to test the browser's finalization behavior.

## Consequences

Native browser support and MIME negotiation remain part of the support check;
unsupported browsers retain the text-note fallback. The browser regression
suite must verify that the uploaded blob includes the final audio and has a
duration matching the recording interval. No stored object key, content type
contract, or migration changes are required.
