# Start with container-hosted production inference

**Status:** superseded by ADR 0028

The first Cloudflare production inference provider will package an optimized vision model inside the Python processing container, while local development may use a separate locally hosted provider through the same versioned contract. Workers AI remains an adapter option rather than a version-one dependency because its current general object-detection catalog is not evidence that tiny, visually similar RC cars can be tracked reliably across race footage. The exact container model is benchmark-gated, trading serverless GPU convenience for control over preprocessing, identity state, model versioning, and equivalent pipeline semantics.
