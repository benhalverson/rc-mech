"""Compatibility exports for the public benchmark API."""

from driving_analysis_service.benchmark import evaluate_benchmark
from driving_analysis_service.contracts import (
    AcceptedSubjectObservationEnvelope,
    AcceptedSubjectObservations,
    BenchmarkCase,
    BenchmarkProvenance,
    BenchmarkReport,
    CandidateObservations,
    CorpusManifest,
    GroundTruth,
    GroundTruthCase,
    GroundTruthPass,
    RejectedSubjectObservationEnvelope,
    SubjectObservation,
    SubjectObservationEnvelope,
    SubjectProvenance,
    TrackingGap,
)

__all__ = [
    "AcceptedSubjectObservationEnvelope",
    "AcceptedSubjectObservations",
    "BenchmarkCase",
    "BenchmarkProvenance",
    "BenchmarkReport",
    "CandidateObservations",
    "CorpusManifest",
    "GroundTruth",
    "GroundTruthCase",
    "GroundTruthPass",
    "RejectedSubjectObservationEnvelope",
    "SubjectObservation",
    "SubjectObservationEnvelope",
    "SubjectProvenance",
    "TrackingGap",
    "evaluate_benchmark",
]
