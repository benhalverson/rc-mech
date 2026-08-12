# Use TypeScript orchestration and Python video processing

**Status:** accepted

The existing TypeScript Worker and Cloudflare Workflow own the Driving-analysis API, authorization, lifecycle, domain rules, metadata, and evidence decisions, while a Python container service owns FFmpeg media operations and computer-vision execution. This keeps Chassis Notes consistent with its current TypeScript boundary while choosing Python's mature video and ML ecosystem inside a narrow service contract; the tradeoff is a cross-runtime protocol that must be versioned and tested without allowing the processing service to become a second source of product truth.
