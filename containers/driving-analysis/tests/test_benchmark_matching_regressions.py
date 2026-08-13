from driving_analysis_service.benchmark import (
    CandidatePass,
    _crossings,
    _matching_pass,
    _unflagged_switches,
)
from driving_analysis_service.contracts import (
    AcceptedSubjectObservations,
    BenchmarkProvenance,
    CornerGates,
    CorpusRecording,
    DirectedGate,
    GroundTruthCase,
    GroundTruthPass,
    NormalizedBox,
    NormalizedPoint,
    RationalValue,
    SubjectIdentityAnnotation,
    SubjectObservation,
    SubjectProvenance,
)

PROVENANCE = BenchmarkProvenance(
    dockerImageDigest="1" * 64,
    pythonLockfileDigest="2" * 64,
    ffmpegVersion="7.1",
    provider="fixture",
    model="fixture",
    modelVersion="1",
    modelDigest="3" * 64,
    pipelineVersion="subject-benchmark.v1",
    configurationDigest="4" * 64,
    identityConfidenceThreshold=0.5,
    confidenceCalibration="fixture-v1",
    identityMatchIouThreshold=0.5,
    identityAnnotationToleranceMs=50,
    maximumObservationIntervalMs=250,
    passMatchToleranceMs=250,
    ambiguityGapCoverageToleranceMs=0,
)

RECORDING = CorpusRecording(
    recordingId="recording",
    checksumSha256="5" * 64,
    byteCount=1,
    durationMs=1_000,
    decodedFrameCount=30,
    width=1,
    height=1,
    videoCodec="fixture",
    containerFormats=("mov",),
    averageFrameRate=RationalValue(numerator=30, denominator=1),
)


def _box(center_x: float) -> NormalizedBox:
    return NormalizedBox(x=center_x - 0.05, y=0.4, width=0.1, height=0.1)


def _observation(
    timestamp_ms: int, frame_index: int, center_x: float
) -> SubjectObservation:
    return SubjectObservation(
        timestampMs=timestamp_ms,
        frameIndex=frame_index,
        box=_box(center_x),
        center=NormalizedPoint(x=center_x, y=0.45),
        visibility="visible",
        identityConfidence=1.0,
        origin="detected",
        provenance=SubjectProvenance(
            provider=PROVENANCE.provider,
            model=PROVENANCE.model,
            modelVersion=PROVENANCE.model_version,
            modelDigest=PROVENANCE.model_digest,
            pipelineVersion=PROVENANCE.pipeline_version,
            configurationDigest=PROVENANCE.configuration_digest,
            identityConfidenceThreshold=PROVENANCE.identity_confidence_threshold,
            confidenceCalibration=PROVENANCE.confidence_calibration,
        ),
    )


def test_exact_directed_gate_contact_is_counted_once() -> None:
    candidate = AcceptedSubjectObservations(
        contractVersion="subject-observation.v1",
        outcome="accepted",
        caseId="case",
        gaps=(),
        observations=(
            _observation(0, 0, 0.2),
            _observation(100, 3, 0.5),
            _observation(200, 6, 0.8),
        ),
    )
    gate = DirectedGate(
        entry=NormalizedPoint(x=0.5, y=0.0),
        exit=NormalizedPoint(x=0.5, y=1.0),
        direction="negative",
    )

    assert _crossings(candidate, gate, 0.5, 250) == (100.0,)


def test_identity_matching_requires_frame_alignment_with_timestamp_alignment() -> None:
    truth = GroundTruthCase(
        caseId="case",
        subjectIdentity="subject",
        identityAnnotations=(
            SubjectIdentityAnnotation(timestampMs=0, frameIndex=0, box=_box(0.2)),
            SubjectIdentityAnnotation(timestampMs=200, frameIndex=6, box=_box(0.5)),
        ),
        gates={
            "corner": CornerGates(
                entry=DirectedGate(
                    entry=NormalizedPoint(x=0.5, y=0.0),
                    exit=NormalizedPoint(x=0.5, y=1.0),
                    direction="negative",
                ),
                exit=DirectedGate(
                    entry=NormalizedPoint(x=0.7, y=0.0),
                    exit=NormalizedPoint(x=0.7, y=1.0),
                    direction="negative",
                ),
            )
        },
    )
    aligned = AcceptedSubjectObservations(
        contractVersion="subject-observation.v1",
        outcome="accepted",
        caseId="case",
        gaps=(),
        observations=(_observation(0, 0, 0.2), _observation(200, 7, 0.5)),
    )
    wrong_frame = aligned.model_copy(
        update={
            "observations": (
                aligned.observations[0],
                _observation(200, 8, 0.5),
            )
        }
    )

    assert _unflagged_switches(truth, aligned, PROVENANCE, RECORDING, 1) == 0
    assert _unflagged_switches(truth, wrong_frame, PROVENANCE, RECORDING, 1) == 1


def test_pass_matching_is_bounded_and_monotonic() -> None:
    expected = GroundTruthPass(
        passId="expected", cornerId="corner", entryTimestampMs=100, exitTimestampMs=200
    )
    candidates = (CandidatePass(entry_ms=600, exit_ms=700),)

    assert _matching_pass(expected, candidates, set(), 250) is None

    ordered = (
        CandidatePass(entry_ms=100, exit_ms=200),
        CandidatePass(entry_ms=300, exit_ms=400),
    )
    later_expected = expected.model_copy(
        update={"entry_timestamp_ms": 300, "exit_timestamp_ms": 400}
    )
    assert _matching_pass(later_expected, ordered, set(), 250, minimum_index=1) == (
        1,
        ordered[1],
    )
    assert _matching_pass(later_expected, ordered, set(), 250, minimum_index=2) is None
