# Version Track maps without retroactive analysis

**Status:** accepted

Every approved Track map is immutable, and an Owner-approved edit publishes a new Track-map version. A Driving analysis permanently references the version used for its gate timing and clips; later geometry corrections do not recalculate old traversal times or replace their Best corner pass. This preserves reproducible evidence at the cost of retaining historical map versions and requiring an explicit new processing run when a User wants an older analysis evaluated against newer geometry.
