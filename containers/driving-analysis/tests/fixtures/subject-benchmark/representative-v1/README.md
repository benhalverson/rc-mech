# Representative private Race corpus v1

This directory contains only privacy-safe evidence derived by manual frame
review. The three opaque entries cover complete 360-second Race windows from
three fixed 16:9 recordings, three different Subject cars, seven- and eight-car
fields, similar-looking competitors, occlusion, and identity ambiguity. Source
recordings and extracted frames remain private and outside the repository.

The manifest records the authorized uses of each checksum. Publishing a
checksum is authorized; redistribution and remote processing are prohibited.
The checksum remains a stable fingerprint of private media and must not be
treated as permission to obtain or share the source.

`ground-truth.json` uses absolute source milliseconds, zero-based decoded-frame
indexes, and normalized Track-view coordinates. Its reviewed gates and passes
occur before the first known ambiguity that would require User
Re-identification. In v2, the coverage denominator contains only passes ending
before that first ambiguity. A stored observation artifact opens one continuous
Tracking gap from the first ambiguity through the end of the complete Race
window when no User Re-identification evidence is supplied.

`reference-observations.json` is a manual reference artifact, not an inference
provider result. It proves the representative contracts and deterministic
benchmark path; it does not qualify a model for production. The expected report
is bound to canonical manifest, ground-truth, and observation-set digests.

To evaluate the committed reference without media or a provider:

```console
uv run --frozen subject-benchmark \
  --manifest tests/fixtures/subject-benchmark/representative-v1/manifest.json \
  --ground-truth tests/fixtures/subject-benchmark/representative-v1/ground-truth.json \
  --observations tests/fixtures/subject-benchmark/representative-v1/reference-observations.json \
  --output /tmp/representative-subject-report.json
```

Candidate generation is a separate private operation. Outside the Git
worktree, it must verify the source checksum, enforce the declared permitted-use
policy, decode only the declared Race window and fixed bottom-two-thirds Track
view, and invoke the selected provider with credentials supplied by that local
environment. It then emits strict `subject-observation.v1` cases with immutable
provider, model, image, pipeline, calibration, threshold, and configuration
provenance. The cases are wrapped in
`subject-benchmark-observations.v1`, bound to the canonical manifest and
ground-truth digests, reviewed for private paths and provider details, and only
then may replace the stored candidate artifact. The `subject-benchmark` command
never reads media, invokes a provider, resolves an endpoint, or reads
credentials.
