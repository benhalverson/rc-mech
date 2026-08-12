# Limit AI to Subject-car observations

**Status:** accepted

AI providers locate the Subject car and emit timestamped, confidence-bearing Subject observations, including visibility and possible occlusion; they do not define corner geometry, time gates, determine eligibility, or choose the Best corner pass. Versioned deterministic code performs those evidence calculations against a reviewed Track map. This rejects a simpler end-to-end model judgment in favor of reproducible results, explicit uncertainty, and equivalent semantics across local and Cloudflare inference providers.
