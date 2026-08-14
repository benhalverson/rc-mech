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
indexes, and normalized Track-view coordinates. Known ambiguity spans identify
where a Tracking gap is expected. Every reviewed Corner pass remains in the
coverage denominator; ambiguity cannot erase later ground-truth evidence. A
finite stored Tracking gap represents the interval that required User
Re-identification, and trusted observations may resume after that gap.

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
  --output representative-subject-report.json
```

Candidate generation is a separate private operation. Outside the Git
worktree, it must verify the source checksum, enforce the declared permitted-use
policy, decode only the declared Race window and fixed bottom-two-thirds Track
view, and invoke the selected provider with credentials supplied by that local
environment. It then emits strict `subject-observation.v1` cases with immutable
provider, model, image, pipeline, calibration, threshold, and configuration
provenance. The cases and their candidate-specific generation provenance are
wrapped in `subject-benchmark-observations.v1`. The envelope binds that
generation evidence and the cases to the provider-neutral canonical manifest
and ground-truth digests. It is reviewed for private paths and provider details
before it may replace the stored candidate artifact. The `subject-benchmark`
command never reads media, invokes a provider, resolves an endpoint, or reads
credentials.
