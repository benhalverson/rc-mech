import type {
	CancelCommand,
	ExecutionIdentity,
	JobStatus,
	TrackingJobSubmission,
	TransferGrantCommand,
} from '../driving-analysis/tracking/contracts';
import type { InferenceProfile } from '../driving-analysis/tracking/inference-profile';

export const RUN_ID = '11111111-1111-4111-8111-111111111111';
export const SEGMENT_ID = '22222222-2222-4222-8222-222222222222';
export const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
export const LEASE_ID = '44444444-4444-4444-8444-444444444444';
export const PREPARED_ID = '55555555-5555-4555-8555-555555555555';
export const CORRELATION_ID = '66666666-6666-4666-8666-666666666666';
export const TRANSFER_ID = '77777777-7777-4777-8777-777777777777';
export const SHA = '1'.repeat(64);
export const PROFILE_DIGEST =
	'5abae405db4372b704fe5c0984d1d8a2ed02363a52fbeac5ea09b0f7ec7a6b58';

export const inferenceProfileFixture = (): InferenceProfile => ({
	contractVersion: 'inference-profile.v1',
	canonicalizationVersion: 'inference-profile-c14n.v1',
	provider: 'local-sam31',
	model: {
		name: 'sam3.1',
		version: '96914d2425f90a64f45ca977c2b5165418099543',
		digest: '1'.repeat(64),
	},
	pipeline: { version: 'subject-tracking.v1', digest: '2'.repeat(64) },
	runtimeImageDigest: '3'.repeat(64),
	preprocessing: 'fixed-track-view-frames.v1',
	precision: 'float32',
	confidenceCalibration: 'sam31-point-mask-v1',
	identityConfidenceThreshold: 0.3,
	promptSemantics: 'subject-box-center-positive-point.v1',
	tracking: {
		minimumAreaRatio: 0.05,
		maximumSeedAreaRatio: 25,
		maximumFrameAreaRatio: 8,
		maximumCenterDisplacement: 0.35,
	},
});

export const executionIdentityFixture = (): ExecutionIdentity => ({
	runId: RUN_ID,
	segmentId: SEGMENT_ID,
	attemptId: ATTEMPT_ID,
	leaseId: LEASE_ID,
	fencingToken: 7,
	specificationDigest: '4'.repeat(64),
	profileDigest: PROFILE_DIGEST,
});

export const submissionFixture = (): TrackingJobSubmission => ({
	contractVersion: 'tracking-provider.v1',
	...executionIdentityFixture(),
	trackingRequest: {
		contractVersion: 'subject-tracking.v1',
		correlationId: CORRELATION_ID,
		caseId: 'fixture-race',
		observationSegmentId: SEGMENT_ID,
		prepared: {
			preparedMediaId: PREPARED_ID,
			caseId: 'fixture-race',
			byteCount: 14,
			checksumSha256: '5'.repeat(64),
			frameManifestByteCount: 14,
			frameManifestChecksumSha256: '6'.repeat(64),
			sourceByteCount: 100,
			sourceChecksumSha256: '7'.repeat(64),
			window: { startTimestampMs: 100, endTimestampMs: 400 },
			trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
			width: 160,
			height: 60,
			decodedFrameCount: 3,
			averageFrameRate: { numerator: 10, denominator: 1 },
			ffmpegVersion: '7.1.2',
			pipelineVersion: 'subject-tracking.v1',
			preparationInputDigest: '8'.repeat(64),
			preparationConfigurationDigest: '9'.repeat(64),
		},
		subjectSeed: {
			timestampMs: 100,
			frameIndex: 1,
			identity: 'subject',
			box: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
		},
	},
});

export const jobStatusFixture = (withArtifact = false): JobStatus => ({
	contractVersion: 'tracking-provider.v1',
	...executionIdentityFixture(),
	state: withArtifact ? 'output-ready' : 'transfer-grant-required',
	resolvedProfileDigest: PROFILE_DIGEST,
	progress: withArtifact ? 90 : 0,
	transferRequest: {
		transferRequestId: TRANSFER_ID,
		role: withArtifact ? 'observation-artifact' : 'prepared-media',
		method: withArtifact ? 'PUT' : 'GET',
	},
	artifact: withArtifact
		? {
				contractVersion: 'tracking-artifact.v1',
				...executionIdentityFixture(),
				segment: {
					observationSegmentId: SEGMENT_ID,
					caseId: 'fixture-race',
					byteCount: 20,
					checksumSha256: 'a'.repeat(64),
					contentEncoding: 'gzip',
					mediaType: 'application/vnd.rc-mech.subject-observations+json',
					observationCount: 3,
					completed: true,
					gap: null,
					provenance: {
						provider: 'sam31',
						model: 'sam3.1',
						modelVersion: '96914d2425f90a64f45ca977c2b5165418099543',
						pipelineVersion: 'subject-tracking.v1',
						configurationDigest: 'b'.repeat(64),
						modelDigest: '1'.repeat(64),
						identityConfidenceThreshold: 0.3,
						confidenceCalibration: 'sam31-point-mask-v1',
					},
					ffmpegVersion: '7.1.2',
					sourceChecksumSha256: '7'.repeat(64),
					preparedChecksumSha256: '5'.repeat(64),
					preparationConfigurationDigest: '9'.repeat(64),
					trackingInputDigest: 'c'.repeat(64),
				},
			}
		: null,
	error: null,
});

export const cancelFixture = (): CancelCommand => ({
	contractVersion: 'tracking-provider.v1',
	...executionIdentityFixture(),
});

export const transferGrantFixture = (): TransferGrantCommand => ({
	contractVersion: 'tracking-provider.v1',
	...executionIdentityFixture(),
	transferRequestId: TRANSFER_ID,
	role: 'prepared-media',
	method: 'GET',
	url: 'https://r2.example/prepared?signature=secret',
	expiresAt: 2_000_000_000,
});
