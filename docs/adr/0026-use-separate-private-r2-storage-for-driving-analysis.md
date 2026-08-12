# Use separate private R2 storage for Driving analysis

**Status:** accepted

User-uploaded Race recordings, Driving-analysis working media, Subject-observation artifacts, and Corner clips are stored in a new private `ANALYSIS_MEDIA` R2 bucket rather than the existing compatibility-sensitive `PHOTOS` bucket or D1. Race recordings remain private and reusable until the User deletes them, working Race-window media is deleted within 24 hours of a terminal run, and observations and eligible Corner clips remain until the User deletes the analysis. This separates large-video cost and lifecycle policy from garage photos and voice media at the cost of another binding and explicit cross-store cleanup.
