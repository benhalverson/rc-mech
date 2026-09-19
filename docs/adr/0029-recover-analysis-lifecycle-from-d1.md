# ADR 0029: Recover analysis lifecycle and private-media cleanup from D1

Status: Accepted

## Context

Workflow dispatch and R2 deletion can fail independently of an owner command.
Accepted tracking, measurement, and clip provenance is immutable. Deleting its
parent rows would break that provenance and its foreign keys. Preparation can
also upload objects before it has an accepted D1 descriptor.

## Decision

An owner retry records its command ID and new Workflow identity in the same D1
batch as the optimistic analysis transition. Replaying that command resumes the
same generation. Existing callers without a command ID retain a deterministic
analysis-and-version identity. The batch rechecks that the source is still ready;
source deletion claims exclude queued analyses as well as active tracking runs.

Analysis deletion fences active runs and marks the analysis deleting before
dispatching the existing cancellation Workflow or touching R2. A separate
owner-scoped deletion record contains only identity and cleanup timestamps.
Normal analysis and evidence reads stop at that fence. A lifecycle read returns
minimal status, revision, retry eligibility, and safe failure information.

Scheduled maintenance retries deletion from authoritative planned and accepted
object identities. It preserves source recordings and immutable internal
provenance. It marks the analysis deleted only after all selected R2 deletes
succeed and revisits tombstones daily to remove uploads that finished late.
The UI explains that media removal is permanent and that pending cleanup retries
automatically.

Preparation records an object identity before invoking media processing. A
cleanup claim after 24 hours permanently fences acceptance of that abandoned
identity; accepted active or awaiting-reidentification media remains protected.
Accepted prepared media retains its existing terminal-plus-24-hour and
delete-after conditions. Failure publication records the run terminal timestamp
atomically with the analysis failure.

Maintenance categories and individual R2 deletions fail independently. Staging
scans read at most ten listing pages per invocation and persist their continuation
cursor in D1. Accepted observations and clips are retained until analysis deletion.

## Schema provenance

The lifecycle tables are declared in
`src/driving-analysis/analysis/lifecycle-schema.ts`. Migration
`0036_analysis_lifecycle.sql` is the single `drizzle-kit generate` delta from
the existing 39-table schema to the schema containing the four lifecycle tables.
No SQL was handwritten. Disposable generator snapshots remain outside the
repository, matching the existing flat migration directory.

## Consequences

Deletion retains immutable internal metadata; the public tombstone does not
expose source locations or analysis inputs. Cancellation still uses the
60-second unreachable-worker grace from ADR 0028. Cleanup is retryable after
partial storage failures and never implies that an unreachable physical process
has stopped.
