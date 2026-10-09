"""Saved corpus, annotation, and report contracts for provider-neutral benchmark
evaluation.

Model responsibilities (kept here to preserve generated schema descriptions):
CorpusRecording: Pins source checksum, byte count, duration, and decoded timing
    facts
    for a corpus recording.
PermittedUseV1: Records permitted benchmark uses and separately authorized remote
    processing without storing authorization evidence.
FixedCameraFramingV1: Pins fixed camera/zoom and the normalized Track-view
    convention
    used by annotations.
RepresentativeCorpusRecordingV2: Adds authorized use and 16:9 fixed-camera framing
    to
    representative source evidence.
BenchmarkCase: Binds a subject seed and ordered source window to one corpus
    recording.
RepresentativeCaseFactsV1: Checks field counts and identity challenges that justify
    representative case coverage.
RepresentativeBenchmarkCaseV2: Adds those representative facts to the otherwise
    shared
    case identity/window.
BenchmarkProvenance: Pins inference/runtime identity and evaluation thresholds so
    reports cannot mix configurations.
BenchmarkEvaluationPolicyV1: Separates scoring tolerances from candidate-generation
    provenance for representative evaluation.
CorpusRecordingManifest: Validates unique recording IDs in the saved corpus index.
CorpusManifest: Adds unique cases, required pass coverage, and v1 scoring provenance
    to the recording index.
RepresentativeCorpusManifestV2: Requires a sufficiently varied representative corpus
    and an explicit evaluation policy.
GroundTruthPass: Annotated ordered entry/exit times for one Corner pass, used as the
    matching target.
SubjectIdentityAnnotation: Manual source-frame box evidence used to detect unflagged
    identity switches.
GroundTruthCase: Collects gates, passes, ambiguity intervals, and identity
    annotations
    for one seeded subject.
AnnotationProvenanceV1: Pins manual review conventions, tool identity, source
    checksum, and adjudication evidence.
RepresentativeGroundTruthCaseV2: Adds annotation provenance to a representative
    case's
    expected evidence.
GroundTruth: Validates unique annotated cases tied to the v1 corpus identity.
RepresentativeGroundTruthV2: Requires representative annotation cases under the v2
    ground-truth contract.
CoverageMetrics: Counts eligible versus annotated passes so the coverage ratio has
    explicit denominators.
GapMetrics: Separates timely, missed, and premature ambiguity flags for the
    benchmark
    report.
IdentityMetrics: Reports unflagged switches independently of pass coverage.
GateTimingMetrics: Carries timing-error aggregates while allowing absent values when
    no pass was matched.
BenchmarkReport: Combines reproducibility identity, pass/fail, coverage, gap,
    identity, and timing results.
BenchmarkObservationSetV2: Binds stored provider observations to manifest, ground
    truth, generation, and inference digests.
BenchmarkEvidenceV2: Retains the digest chain needed to reproduce a representative
    report.
RepresentativeBenchmarkReportV2: Adds initial-seed coverage and the retained
    evidence
    digest chain to the report.
"""
# ruff: noqa: EM101, TRY003

from typing import Annotated, Literal

from pydantic import (
    Field,
    StringConstraints,
    model_validator,
)

from driving_analysis_service.contract_primitives import (
    MAX_BENCHMARK_FRAME_COUNT,
    MAX_BENCHMARK_TIMESTAMP_MS,
    MIN_REPRESENTATIVE_FIELD_COUNTS,
    MIN_REPRESENTATIVE_RECORDINGS,
    SHA256_PATTERN,
    SafeFreeFormIdentifier,
    StrictContract,
)
from driving_analysis_service.geometry_contracts import (
    CornerGates,
    NormalizedBox,
    RationalValue,
    SubjectSeed,
)
from driving_analysis_service.observation_contracts import (
    AcceptedSubjectObservations,
    InferenceProvenance,
    TrackingGap,
)


class CorpusRecording(StrictContract):
    recording_id: SafeFreeFormIdentifier = Field(alias="recordingId")
    checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="checksumSha256")
    byte_count: int = Field(alias="byteCount", gt=0, strict=True)
    duration_ms: int = Field(
        alias="durationMs", gt=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    decoded_frame_count: int = Field(
        alias="decodedFrameCount", gt=0, le=MAX_BENCHMARK_FRAME_COUNT, strict=True
    )
    width: int = Field(gt=0, strict=True)
    height: int = Field(gt=0, strict=True)
    video_codec: SafeFreeFormIdentifier = Field(alias="videoCodec")
    container_formats: tuple[SafeFreeFormIdentifier, ...] = Field(
        alias="containerFormats", min_length=1, max_length=8, strict=False
    )
    average_frame_rate: RationalValue = Field(alias="averageFrameRate")

    @model_validator(mode="after")
    def average_frame_rate_is_positive(self) -> "CorpusRecording":
        if self.average_frame_rate.numerator <= 0:
            raise ValueError("average frame rate must be positive")
        return self


class PermittedUseV1(StrictContract):
    statement_version: Literal["private-benchmark-use.v1"] = Field(
        alias="statementVersion"
    )
    basis: Literal["user-owned", "user-authorized", "licensed"]
    manual_annotation: Literal["permitted"] = Field(alias="manualAnnotation")
    candidate_generation: Literal["permitted"] = Field(alias="candidateGeneration")
    benchmark_evaluation: Literal["permitted"] = Field(alias="benchmarkEvaluation")
    remote_processing: Literal["prohibited", "separately-authorized"] = Field(
        alias="remoteProcessing"
    )
    redistribution: Literal["prohibited"]
    checksum_publication: Literal["permitted"] = Field(alias="checksumPublication")
    authorization_evidence: Literal["retained-outside-repository"] = Field(
        alias="authorizationEvidence"
    )


class FixedCameraFramingV1(StrictContract):
    framing_version: Literal["fixed-16:9-main-camera.v1"] = Field(
        alias="framingVersion"
    )
    camera_position: Literal["fixed"] = Field(alias="cameraPosition")
    camera_zoom: Literal["fixed"] = Field(alias="cameraZoom")
    track_view_x: float = Field(alias="trackViewX", strict=True)
    track_view_y: float = Field(alias="trackViewY", strict=True)
    track_view_width: float = Field(alias="trackViewWidth", strict=True)
    track_view_height: float = Field(alias="trackViewHeight", strict=True)
    coordinate_space: Literal["normalized-track-view.v1"] = Field(
        alias="coordinateSpace"
    )

    @model_validator(mode="after")
    def track_view_is_fixed(self) -> "FixedCameraFramingV1":
        if (
            self.track_view_x,
            self.track_view_y,
            self.track_view_width,
            self.track_view_height,
        ) != (0.0, 1 / 3, 1.0, 2 / 3):
            raise ValueError("Track view must be the fixed bottom two-thirds")
        return self


class RepresentativeCorpusRecordingV2(CorpusRecording):
    permitted_use: PermittedUseV1 = Field(alias="permittedUse")
    framing: FixedCameraFramingV1

    @model_validator(mode="after")
    def dimensions_are_16_by_9(self) -> "RepresentativeCorpusRecordingV2":
        if self.width * 9 != self.height * 16:
            raise ValueError("representative recording must be exactly 16:9")
        return self


class BenchmarkCase(StrictContract):
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    recording_id: SafeFreeFormIdentifier = Field(alias="recordingId")
    window_start_ms: int = Field(
        alias="windowStartMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    window_end_ms: int = Field(
        alias="windowEndMs", gt=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    subject_seed: SubjectSeed = Field(alias="subjectSeed")

    @model_validator(mode="after")
    def window_is_ordered(self) -> "BenchmarkCase":
        if self.window_end_ms <= self.window_start_ms:
            raise ValueError("benchmark window must be ordered")
        if (
            not self.window_start_ms
            <= self.subject_seed.timestamp_ms
            <= self.window_end_ms
        ):
            raise ValueError("subject seed must be inside benchmark window")
        return self


class RepresentativeCaseFactsV1(StrictContract):
    complete_race_window: Literal[True] = Field(alias="completeRaceWindow")
    field_car_count: int = Field(alias="fieldCarCount", ge=2, le=100, strict=True)
    similar_looking_competitor_count: int = Field(
        alias="similarLookingCompetitorCount", ge=0, le=99, strict=True
    )
    identity_challenges: tuple[Literal["occlusion", "identity-ambiguity"], ...] = Field(
        alias="identityChallenges", min_length=1, max_length=2, strict=False
    )

    @model_validator(mode="after")
    def facts_are_consistent(self) -> "RepresentativeCaseFactsV1":
        if self.similar_looking_competitor_count >= self.field_car_count:
            raise ValueError("similar-looking competitors must be fewer than the field")
        if len(set(self.identity_challenges)) != len(self.identity_challenges):
            raise ValueError("identity challenges must be unique")
        return self


class RepresentativeBenchmarkCaseV2(BenchmarkCase):
    representative_facts: RepresentativeCaseFactsV1 = Field(alias="representativeFacts")


class BenchmarkProvenance(InferenceProvenance):
    docker_image_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="dockerImageDigest")
    python_lockfile_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="pythonLockfileDigest")
    ffmpeg_version: SafeFreeFormIdentifier = Field(alias="ffmpegVersion")
    identity_match_iou_threshold: float = Field(
        alias="identityMatchIouThreshold", gt=0.0, le=1.0, strict=True
    )
    identity_annotation_tolerance_ms: int = Field(
        alias="identityAnnotationToleranceMs", ge=0, le=1_000, strict=True
    )
    maximum_observation_interval_ms: int = Field(
        alias="maximumObservationIntervalMs", gt=0, le=10_000, strict=True
    )
    pass_match_tolerance_ms: int = Field(
        alias="passMatchToleranceMs", ge=0, le=10_000, strict=True
    )
    ambiguity_gap_coverage_tolerance_ms: int = Field(
        alias="ambiguityGapCoverageToleranceMs", ge=0, le=10_000, strict=True
    )


class BenchmarkEvaluationPolicyV1(StrictContract):
    identity_match_iou_threshold: float = Field(
        alias="identityMatchIouThreshold", gt=0.0, le=1.0, strict=True
    )
    identity_annotation_tolerance_ms: int = Field(
        alias="identityAnnotationToleranceMs", ge=0, le=1_000, strict=True
    )
    maximum_observation_interval_ms: int = Field(
        alias="maximumObservationIntervalMs", gt=0, le=10_000, strict=True
    )
    pass_match_tolerance_ms: int = Field(
        alias="passMatchToleranceMs", ge=0, le=10_000, strict=True
    )
    ambiguity_gap_coverage_tolerance_ms: int = Field(
        alias="ambiguityGapCoverageToleranceMs", ge=0, le=10_000, strict=True
    )

    @classmethod
    def from_provenance(
        cls, provenance: BenchmarkProvenance
    ) -> "BenchmarkEvaluationPolicyV1":
        return cls(
            identityMatchIouThreshold=provenance.identity_match_iou_threshold,
            identityAnnotationToleranceMs=provenance.identity_annotation_tolerance_ms,
            maximumObservationIntervalMs=provenance.maximum_observation_interval_ms,
            passMatchToleranceMs=provenance.pass_match_tolerance_ms,
            ambiguityGapCoverageToleranceMs=(
                provenance.ambiguity_gap_coverage_tolerance_ms
            ),
        )


class CorpusRecordingManifest(StrictContract):
    contract_version: Literal["subject-benchmark.v1"] = Field(alias="contractVersion")
    corpus_id: SafeFreeFormIdentifier = Field(alias="corpusId")
    recordings: tuple[CorpusRecording, ...] = Field(
        min_length=1, max_length=100, strict=False
    )

    @model_validator(mode="after")
    def recording_ids_are_unique(self) -> "CorpusRecordingManifest":
        if len({item.recording_id for item in self.recordings}) != len(self.recordings):
            raise ValueError("benchmark recording IDs must be unique")
        return self


class CorpusManifest(CorpusRecordingManifest):
    cases: tuple[BenchmarkCase, ...] = Field(min_length=1, max_length=100, strict=False)
    required_coverage: float = Field(
        default=0.8, alias="requiredCoverage", ge=0.8, le=1.0, strict=True
    )
    pass_match_tolerance_ms: int = Field(
        default=500, alias="passMatchToleranceMs", ge=0, le=10_000, strict=True
    )
    frame_timestamp_tolerance_ms: int = Field(
        alias="frameTimestampToleranceMs", ge=0, strict=True
    )
    provenance: BenchmarkProvenance

    @model_validator(mode="after")
    def case_ids_are_unique(self) -> "CorpusManifest":
        if len({case.case_id for case in self.cases}) != len(self.cases):
            raise ValueError("benchmark case IDs must be unique")
        recording_ids = {recording.recording_id for recording in self.recordings}
        recordings = {
            recording.recording_id: recording for recording in self.recordings
        }
        if any(case.recording_id not in recording_ids for case in self.cases):
            raise ValueError("benchmark case references an unknown recording")
        if any(
            case.window_end_ms > recordings[case.recording_id].duration_ms
            for case in self.cases
            if case.recording_id in recordings
        ):
            raise ValueError("benchmark case window exceeds recording duration")
        return self


class RepresentativeCorpusManifestV2(CorpusRecordingManifest):
    contract_version: Literal["subject-benchmark.v2"] = Field(  # type: ignore[assignment]
        alias="contractVersion"
    )
    recordings: tuple[RepresentativeCorpusRecordingV2, ...] = Field(
        min_length=3, max_length=100, strict=False
    )
    cases: tuple[RepresentativeBenchmarkCaseV2, ...] = Field(
        min_length=3, max_length=100, strict=False
    )
    required_coverage: float = Field(
        default=0.8, alias="requiredCoverage", ge=0.8, le=1.0, strict=True
    )
    frame_timestamp_tolerance_ms: int = Field(
        alias="frameTimestampToleranceMs",
        ge=0,
        le=1_000,
        strict=True,
    )
    evaluation_policy: BenchmarkEvaluationPolicyV1 = Field(alias="evaluationPolicy")

    @model_validator(mode="after")
    def corpus_is_representative(self) -> "RepresentativeCorpusManifestV2":
        if len({case.case_id for case in self.cases}) != len(self.cases):
            raise ValueError("benchmark case IDs must be unique")
        recordings = {
            recording.recording_id: recording for recording in self.recordings
        }
        if any(case.recording_id not in recordings for case in self.cases):
            raise ValueError("benchmark case references an unknown recording")
        if any(
            case.window_end_ms > recordings[case.recording_id].duration_ms
            for case in self.cases
            if case.recording_id in recordings
        ):
            raise ValueError("benchmark case window exceeds recording duration")
        if (
            len({case.recording_id for case in self.cases})
            < MIN_REPRESENTATIVE_RECORDINGS
        ):
            raise ValueError("representative corpus requires three recording windows")
        identities = {case.subject_seed.identity for case in self.cases}
        if len(identities) != len(self.cases):
            raise ValueError("representative Subject identities must be distinct")
        facts = tuple(case.representative_facts for case in self.cases)
        if (
            len({item.field_car_count for item in facts})
            < MIN_REPRESENTATIVE_FIELD_COUNTS
        ):
            raise ValueError("representative field densities must differ")
        if not any(item.similar_looking_competitor_count > 0 for item in facts):
            raise ValueError(
                "representative corpus requires a similar-looking competitor"
            )
        challenges = {
            challenge for item in facts for challenge in item.identity_challenges
        }
        if challenges != {"occlusion", "identity-ambiguity"}:
            raise ValueError("representative corpus requires both identity challenges")
        if any(
            2
            * self.frame_timestamp_tolerance_ms
            * recording.average_frame_rate.numerator
            > 1_000 * recording.average_frame_rate.denominator
            for recording in self.recordings
        ):
            raise ValueError(
                "representative frame timestamp tolerance exceeds half a frame"
            )
        return self


class GroundTruthPass(StrictContract):
    pass_id: SafeFreeFormIdentifier = Field(alias="passId")
    corner_id: SafeFreeFormIdentifier = Field(alias="cornerId")
    entry_timestamp_ms: int = Field(
        alias="entryTimestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    exit_timestamp_ms: int = Field(
        alias="exitTimestampMs", gt=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )

    @model_validator(mode="after")
    def ordered(self) -> "GroundTruthPass":
        if self.exit_timestamp_ms <= self.entry_timestamp_ms:
            raise ValueError("ground-truth pass must be ordered")
        return self


class SubjectIdentityAnnotation(StrictContract):
    timestamp_ms: int = Field(
        alias="timestampMs", ge=0, le=MAX_BENCHMARK_TIMESTAMP_MS, strict=True
    )
    frame_index: int = Field(
        alias="frameIndex", ge=0, lt=MAX_BENCHMARK_FRAME_COUNT, strict=True
    )
    box: NormalizedBox


class GroundTruthCase(StrictContract):
    case_id: SafeFreeFormIdentifier = Field(alias="caseId")
    subject_identity: SafeFreeFormIdentifier = Field(alias="subjectIdentity")
    ambiguous_spans: tuple[TrackingGap, ...] = Field(
        default=(), alias="ambiguousSpans", max_length=100_000, strict=False
    )
    identity_annotations: tuple[SubjectIdentityAnnotation, ...] = Field(
        alias="identityAnnotations", min_length=1, max_length=100_000, strict=False
    )
    gates: Annotated[
        dict[
            SafeFreeFormIdentifier,
            CornerGates,
        ],
        Field(min_length=1, max_length=256),
    ]
    passes: tuple[GroundTruthPass, ...] = Field(
        default=(), max_length=10_000, strict=False
    )

    @model_validator(mode="after")
    def pass_corners_exist(self) -> "GroundTruthCase":
        if any(item.corner_id not in self.gates for item in self.passes):
            raise ValueError("ground-truth pass references an unknown corner")
        if len({item.pass_id for item in self.passes}) != len(self.passes):
            raise ValueError("ground-truth pass IDs must be unique")
        if any(
            current.entry_timestamp_ms <= previous.entry_timestamp_ms
            for previous, current in zip(self.passes, self.passes[1:], strict=False)
        ):
            raise ValueError("ground-truth passes must be strictly ordered")
        if any(
            current.timestamp_ms <= previous.timestamp_ms
            or current.frame_index <= previous.frame_index
            for previous, current in zip(
                self.identity_annotations,
                self.identity_annotations[1:],
                strict=False,
            )
        ):
            raise ValueError("identity annotations must be strictly ordered")
        if any(
            current.start_timestamp_ms < previous.end_timestamp_ms
            for previous, current in zip(
                self.ambiguous_spans, self.ambiguous_spans[1:], strict=False
            )
        ):
            raise ValueError("ambiguous spans must be ordered and non-overlapping")
        return self


class AnnotationProvenanceV1(StrictContract):
    annotation_version: SafeFreeFormIdentifier = Field(alias="annotationVersion")
    guideline_version: SafeFreeFormIdentifier = Field(alias="guidelineVersion")
    source_checksum_sha256: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="sourceChecksumSha256")
    method: Literal["manual-frame-review"]
    coordinate_space: Literal["normalized-track-view.v1"] = Field(
        alias="coordinateSpace"
    )
    timestamp_convention: Literal["absolute-source-milliseconds"] = Field(
        alias="timestampConvention"
    )
    frame_index_convention: Literal["zero-based-decoded-frame"] = Field(
        alias="frameIndexConvention"
    )
    tool: SafeFreeFormIdentifier
    tool_version: SafeFreeFormIdentifier = Field(alias="toolVersion")
    reviewer_count: int = Field(alias="reviewerCount", ge=1, le=8, strict=True)
    adjudication: Literal["single-reviewer", "consensus", "independent-adjudication"]


class RepresentativeGroundTruthCaseV2(GroundTruthCase):
    annotation_provenance: AnnotationProvenanceV1 = Field(alias="annotationProvenance")


class GroundTruth(StrictContract):
    contract_version: Literal["subject-benchmark.v1"] = Field(alias="contractVersion")
    corpus_id: SafeFreeFormIdentifier = Field(alias="corpusId")
    cases: tuple[GroundTruthCase, ...] = Field(
        min_length=1, max_length=100, strict=False
    )

    @model_validator(mode="after")
    def case_ids_are_unique(self) -> "GroundTruth":
        if len({case.case_id for case in self.cases}) != len(self.cases):
            raise ValueError("ground-truth case IDs must be unique")
        return self


class RepresentativeGroundTruthV2(GroundTruth):
    contract_version: Literal["subject-benchmark.v2"] = Field(  # type: ignore[assignment]
        alias="contractVersion"
    )
    cases: tuple[RepresentativeGroundTruthCaseV2, ...] = Field(
        min_length=3, max_length=100, strict=False
    )


class CoverageMetrics(StrictContract):
    eligible_passes: int = Field(alias="eligiblePasses", ge=0, strict=True)
    ground_truth_passes: int = Field(alias="groundTruthPasses", ge=0, strict=True)
    ratio: float = Field(ge=0.0, le=1.0, strict=True)


class GapMetrics(StrictContract):
    timely: int = Field(ge=0, strict=True)
    missed: int = Field(ge=0, strict=True)
    premature: int = Field(ge=0, strict=True)


class IdentityMetrics(StrictContract):
    unflagged_switches: int = Field(alias="unflaggedSwitches", ge=0, strict=True)


class GateTimingMetrics(StrictContract):
    count: int = Field(ge=0, strict=True)
    mean_ms: float | None = Field(alias="meanMs", strict=True, allow_inf_nan=False)
    median_ms: float | None = Field(alias="medianMs", strict=True, allow_inf_nan=False)
    max_absolute_ms: float | None = Field(
        alias="maxAbsoluteMs", ge=0.0, strict=True, allow_inf_nan=False
    )


class BenchmarkReport(StrictContract):
    contract_version: Literal["subject-benchmark.v1"] = Field(alias="contractVersion")
    corpus_id: SafeFreeFormIdentifier = Field(alias="corpusId")
    provenance: BenchmarkProvenance
    passed: bool
    coverage: CoverageMetrics
    gaps: GapMetrics
    identity: IdentityMetrics
    timing: GateTimingMetrics


class BenchmarkObservationSetV2(StrictContract):
    contract_version: Literal["subject-benchmark-observations.v1"] = Field(
        alias="contractVersion"
    )
    corpus_id: SafeFreeFormIdentifier = Field(alias="corpusId")
    manifest_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="manifestDigest")
    ground_truth_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="groundTruthDigest")
    generation_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="generationDigest")
    provenance: BenchmarkProvenance
    cases: tuple[AcceptedSubjectObservations, ...] = Field(
        min_length=3, max_length=100, strict=False
    )

    @model_validator(mode="after")
    def case_ids_are_unique(self) -> "BenchmarkObservationSetV2":
        if len({case.case_id for case in self.cases}) != len(self.cases):
            raise ValueError("observation set case IDs must be unique")
        return self


class BenchmarkEvidenceV2(StrictContract):
    manifest_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="manifestDigest")
    ground_truth_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="groundTruthDigest")
    observations_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="observationsDigest")
    generation_digest: Annotated[
        str, StringConstraints(pattern=SHA256_PATTERN, strict=True)
    ] = Field(alias="generationDigest")


class RepresentativeBenchmarkReportV2(BenchmarkReport):
    contract_version: Literal["subject-benchmark.v2"] = Field(  # type: ignore[assignment]
        alias="contractVersion"
    )
    initial_seed_coverage: CoverageMetrics = Field(alias="initialSeedCoverage")
    evidence: BenchmarkEvidenceV2
