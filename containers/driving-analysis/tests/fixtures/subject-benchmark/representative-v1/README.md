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
stored Tracking gap that ends before the next observation represents the
interval that required User Re-identification, and trusted observations resume
only at the reviewed reselection. A `missing` gap that reaches the Race-window
end means the Subject was not trusted again in that window.

The `race-window-b` and `race-window-c` cases contain 70 retained identity
boxes, 14 Corner passes, and 18 explicit gaps across the two 360-second
windows. Local model and color cues were used only to locate frames for
contact-sheet review. They are not Ground Truth: each retained box and crossing
bracket was manually accepted, uncertain intervals were recorded as gaps, and
rejected candidate identities were discarded. The `race-window-a` case remains
the separately reviewed evidence for the first recording.

`reference-observations.json` is a manual reference artifact, not an inference
provider result. The first reviewed observation after each finite loss interval
is explicitly marked as a box-based User Re-identification; ordinary detections
cannot silently stand in for a reselection. The report therefore separates 3 of
15 passes tracked from the initial seed from 15 of 15 automatically eligible
passes across all User-seeded segments. The 80 percent qualification gate
applies to the latter: a reselection may restart tracking, but it cannot make a
Corner pass eligible by itself. The reference retains zero unflagged switches
and timely coverage of all 20 known gaps. This proves deterministic benchmark
mechanics without qualifying a model for production. The expected report is
bound to canonical manifest, ground-truth, and observation-set digests.

To evaluate the committed reference without media or a provider:

```console
uv run --frozen subject-benchmark \
  --manifest tests/fixtures/subject-benchmark/representative-v1/manifest.json \
  --ground-truth tests/fixtures/subject-benchmark/representative-v1/ground-truth.json \
  --observations tests/fixtures/subject-benchmark/representative-v1/reference-observations.json \
  --output representative-subject-report.json
```

This manual reference exits `0` because every retained Corner pass is
automatically tracked within its User-seeded segment. Its separate 20 percent
`initialSeedCoverage` metric makes clear that the original selection did not
last for the complete windows.

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
