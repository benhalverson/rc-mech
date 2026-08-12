# Use a versioned inference-provider boundary

**Status:** accepted

The Python processing service will invoke vision models through a versioned provider interface whose observation and error contracts are independent of where inference runs. Local development can call a locally hosted model, while Cloudflare deployment can use Workers AI or a container-hosted model; each processing run records its exact provider, model, pipeline, and configuration provenance. This portability adds adapter and contract-test work but prevents model hosting from changing Track-map semantics, evidence eligibility, or the public Driving-analysis API.
