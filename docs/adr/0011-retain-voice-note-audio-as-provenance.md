# ADR 0011: Retain private voice-note audio as provenance

- Status: Accepted
- Date: 2026-08-08

## Context

Voice notes are a primary trackside capture feature, and confirmed notes may create setup snapshots or other garage records. Retaining only processed text would remove the owner's ability to verify what was originally said, while retaining audio has privacy and storage consequences.

## Decision

Retain the original private audio and its transcript as the Voice note until the user explicitly deletes it. The original audio is immutable. The transcript and extracted Voice draft may be corrected, but confirmed records retain their link to the originating Voice note as provenance.

## Consequences

Voice-note audio remains private media and requires an explicit deletion workflow. The interface must distinguish original audio, corrected transcript text, and confirmed structured records rather than silently replacing one with another.
