# Mediate container egress through Worker outbound handlers

**Status:** accepted

The production Driving-analysis container denies general internet access and reaches private R2 only through a named Worker outbound handler. The handler validates the container's run identity and enforces object prefixes, ranges, methods, and size limits without exposing broad R2 credentials to the Python process. This uses Cloudflare's container-to-Worker binding bridge instead of arbitrary network access inside the image, accepting an additional proxy contract in exchange for a narrow auditable data boundary that also works under local Wrangler development.
