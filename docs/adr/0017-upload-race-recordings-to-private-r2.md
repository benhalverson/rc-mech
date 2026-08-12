# Upload Race recordings to private R2

**Status:** accepted

The User uploads a Race recording directly into the private `ANALYSIS_MEDIA` R2 bucket through authenticated, resumable multipart API routes, then selects the Race window with Chassis Notes' own video player. The Worker creates every object key, persists upload-part state, verifies ownership on every request, and starts media validation only after multipart completion. This removes every external media-acquisition dependency while adding upload progress, resumability, validation, quota, and source-retention responsibilities to Chassis Notes.
