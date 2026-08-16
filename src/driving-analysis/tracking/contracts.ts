import { z } from 'zod';

const MAX_TIMESTAMP_MS = 86_400_000;
const MAX_FRAME_COUNT = 10_000_000;
const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const uuidV4Schema = z.string().regex(UUID_V4);
export const sha256Schema = z.string().regex(SHA256);

const safeIdentifierSchema = z
	.string()
	.min(1)
	.max(128)
	.refine(
		(value) =>
			![...value].some((character) => {
				const code = character.charCodeAt(0);
				return code < 0x20 || code === 0x7f;
			}) &&
			!value.includes('/') &&
			!value.includes('\\') &&
			!/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(value),
	);

const positiveInt = z.number().int().positive();
const timestampSchema = z.number().int().min(0).max(MAX_TIMESTAMP_MS);
const frameIndexSchema = z
	.number()
	.int()
	.min(0)
	.max(MAX_FRAME_COUNT - 1);

const normalizedBoxSchema = z
	.strictObject({
		x: z.number().min(0).lt(1),
		y: z.number().min(0).lt(1),
		width: z.number().positive().max(1),
		height: z.number().positive().max(1),
	})
	.refine(
		(box) =>
			box.x + box.width <= 1 &&
			box.y + box.height <= 1 &&
			box.width * box.height >= 1e-12,
	);

export const raceWindowSchema = z
	.strictObject({
		startTimestampMs: timestampSchema,
		endTimestampMs: timestampSchema.positive(),
	})
	.refine((window) => window.endTimestampMs > window.startTimestampMs);

const fixedTrackViewSchema = z
	.strictObject({
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
		width: z.number().positive().max(1),
		height: z.number().positive().max(1),
	})
	.refine(
		(view) =>
			view.x === 0 &&
			view.y === 1 / 3 &&
			view.width === 1 &&
			view.height === 2 / 3,
	);

const rationalSchema = z.strictObject({
	numerator: z.number().int(),
	denominator: positiveInt,
});

export const preparedMediaArtifactSchema = z.strictObject({
	preparedMediaId: uuidV4Schema,
	caseId: safeIdentifierSchema,
	byteCount: positiveInt,
	checksumSha256: sha256Schema,
	frameManifestByteCount: positiveInt,
	frameManifestChecksumSha256: sha256Schema,
	sourceByteCount: positiveInt,
	sourceChecksumSha256: sha256Schema,
	window: raceWindowSchema,
	trackView: fixedTrackViewSchema,
	width: positiveInt,
	height: positiveInt,
	decodedFrameCount: positiveInt.max(MAX_FRAME_COUNT),
	averageFrameRate: rationalSchema,
	ffmpegVersion: safeIdentifierSchema,
	pipelineVersion: z.literal('subject-tracking.v1'),
	preparationInputDigest: sha256Schema,
	preparationConfigurationDigest: sha256Schema,
});

export const subjectSeedSchema = z.strictObject({
	timestampMs: timestampSchema,
	frameIndex: frameIndexSchema,
	identity: safeIdentifierSchema,
	box: normalizedBoxSchema,
});

export const trackStageRequestSchema = z
	.strictObject({
		contractVersion: z.literal('subject-tracking.v1'),
		correlationId: uuidV4Schema,
		caseId: safeIdentifierSchema,
		observationSegmentId: uuidV4Schema,
		prepared: preparedMediaArtifactSchema,
		subjectSeed: subjectSeedSchema,
	})
	.refine(
		(request) =>
			request.caseId === request.prepared.caseId &&
			request.subjectSeed.timestampMs >=
				request.prepared.window.startTimestampMs &&
			request.subjectSeed.timestampMs < request.prepared.window.endTimestampMs,
	);

export const executionIdentitySchema = z.strictObject({
	runId: uuidV4Schema,
	segmentId: uuidV4Schema,
	attemptId: uuidV4Schema,
	leaseId: uuidV4Schema,
	fencingToken: positiveInt,
	specificationDigest: sha256Schema,
	profileDigest: sha256Schema,
});

export const trackingJobSubmissionSchema = executionIdentitySchema
	.extend({
		contractVersion: z.literal('tracking-provider.v1'),
		trackingRequest: trackStageRequestSchema,
	})
	.refine(
		(submission) =>
			submission.segmentId === submission.trackingRequest.observationSegmentId,
	);

const transferRoleSchema = z.enum([
	'prepared-media',
	'frame-manifest',
	'observation-artifact',
]);

const transferMethodMatchesRole = (value: {
	role: z.infer<typeof transferRoleSchema>;
	method: 'GET' | 'PUT';
}) => value.method === (value.role === 'observation-artifact' ? 'PUT' : 'GET');

export const transferRequestSchema = z
	.strictObject({
		transferRequestId: uuidV4Schema,
		role: transferRoleSchema,
		method: z.enum(['GET', 'PUT']),
	})
	.refine(transferMethodMatchesRole);

const transferUrlSchema = z
	.url()
	.min(1)
	.max(8192)
	.refine((value) => {
		const url = new URL(value);
		return (
			url.protocol === 'https:' &&
			url.hostname.length > 0 &&
			url.username === '' &&
			url.password === '' &&
			url.hash === ''
		);
	});

export const transferGrantCommandSchema = executionIdentitySchema
	.extend({
		contractVersion: z.literal('tracking-provider.v1'),
		transferRequestId: uuidV4Schema,
		role: transferRoleSchema,
		method: z.enum(['GET', 'PUT']),
		url: transferUrlSchema,
		expiresAt: positiveInt,
	})
	.refine(transferMethodMatchesRole);

export const cancelCommandSchema = executionIdentitySchema.extend({
	contractVersion: z.literal('tracking-provider.v1'),
});

export const subjectProvenanceSchema = z.strictObject({
	provider: safeIdentifierSchema,
	model: safeIdentifierSchema,
	modelVersion: safeIdentifierSchema,
	pipelineVersion: safeIdentifierSchema,
	configurationDigest: sha256Schema,
	modelDigest: sha256Schema,
	identityConfidenceThreshold: z.number().min(0).max(1),
	confidenceCalibration: safeIdentifierSchema,
});

const openTrackingGapSchema = z.strictObject({
	startTimestampMs: timestampSchema,
	reason: z.enum(['ambiguous-identity', 'occluded', 'missing']),
});

const normalizedPointSchema = z.strictObject({
	x: z.number().min(0).max(1),
	y: z.number().min(0).max(1),
});

export const subjectObservationSchema = z
	.strictObject({
		timestampMs: timestampSchema,
		frameIndex: frameIndexSchema,
		box: normalizedBoxSchema,
		center: normalizedPointSchema,
		visibility: z.enum(['visible', 'occluded', 'uncertain']),
		identityConfidence: z.number().min(0).max(1),
		origin: z.enum([
			'detected',
			'user-reidentified-point',
			'user-reidentified-box',
		]),
		provenance: subjectProvenanceSchema,
	})
	.refine(
		(observation) =>
			Math.abs(
				observation.center.x - (observation.box.x + observation.box.width / 2),
			) <= 1e-6 &&
			Math.abs(
				observation.center.y - (observation.box.y + observation.box.height / 2),
			) <= 1e-6,
	);

export const subjectObservationSegmentSchema = z
	.strictObject({
		contractVersion: z.literal('subject-observation-segment.v1'),
		outcome: z.literal('accepted'),
		caseId: safeIdentifierSchema,
		observations: z.array(subjectObservationSchema).max(MAX_FRAME_COUNT),
		openGap: openTrackingGapSchema.nullable(),
		provenance: subjectProvenanceSchema,
	})
	.refine((segment) =>
		segment.observations.every((observation, index) => {
			const previous = segment.observations[index - 1];
			return (
				(previous === undefined ||
					(observation.timestampMs > previous.timestampMs &&
						observation.frameIndex > previous.frameIndex)) &&
				(segment.openGap === null ||
					observation.timestampMs < segment.openGap.startTimestampMs) &&
				JSON.stringify(observation.provenance) ===
					JSON.stringify(segment.provenance)
			);
		}),
	);

export const observationSegmentArtifactSchema = z
	.strictObject({
		observationSegmentId: uuidV4Schema,
		caseId: safeIdentifierSchema,
		byteCount: positiveInt,
		checksumSha256: sha256Schema,
		contentEncoding: z.literal('gzip'),
		mediaType: z.literal('application/vnd.rc-mech.subject-observations+json'),
		observationCount: z.number().int().min(0).max(MAX_FRAME_COUNT),
		completed: z.boolean(),
		gap: openTrackingGapSchema.nullable(),
		provenance: subjectProvenanceSchema,
		ffmpegVersion: safeIdentifierSchema,
		sourceChecksumSha256: sha256Schema,
		preparedChecksumSha256: sha256Schema,
		preparationConfigurationDigest: sha256Schema,
		trackingInputDigest: sha256Schema,
	})
	.refine((artifact) => artifact.completed !== (artifact.gap !== null));

export const outputArtifactSchema = executionIdentitySchema.extend({
	contractVersion: z.literal('tracking-artifact.v1'),
	segment: observationSegmentArtifactSchema,
});

const safeErrorMessages = {
	GPU_CAPACITY_BUSY: 'GPU execution capacity is busy',
	PROFILE_UNAVAILABLE: 'requested inference profile is unavailable',
	JOB_NOT_FOUND: 'Tracking job was not found',
	AUTHORITY_MISMATCH: 'Tracking authority does not match',
	TRANSFER_FAILED: 'artifact transfer failed safely',
	TRACKING_FAILED: 'Tracking execution failed safely',
	JOB_INTERRUPTED: 'Tracking execution was interrupted',
	INVALID_REQUEST: 'request does not match the execution contract',
} as const;

const safeErrorCodeSchema = z.enum([
	'GPU_CAPACITY_BUSY',
	'PROFILE_UNAVAILABLE',
	'JOB_NOT_FOUND',
	'AUTHORITY_MISMATCH',
	'TRANSFER_FAILED',
	'TRACKING_FAILED',
	'JOB_INTERRUPTED',
	'INVALID_REQUEST',
]);

const safeErrorMessageSchema = z.enum([
	'GPU execution capacity is busy',
	'requested inference profile is unavailable',
	'Tracking job was not found',
	'Tracking authority does not match',
	'artifact transfer failed safely',
	'Tracking execution failed safely',
	'Tracking execution was interrupted',
	'request does not match the execution contract',
]);

export const safeJobErrorSchema = z
	.strictObject({
		code: safeErrorCodeSchema,
		message: safeErrorMessageSchema,
	})
	.refine((error) => safeErrorMessages[error.code] === error.message);

export const jobStatusSchema = executionIdentitySchema.extend({
	contractVersion: z.literal('tracking-provider.v1'),
	state: z.enum([
		'transfer-grant-required',
		'transferring',
		'processing',
		'output-ready',
		'completed',
		'cancel-requested',
		'cancelled',
		'interrupted',
		'failed',
	]),
	resolvedProfileDigest: sha256Schema,
	progress: z.number().int().min(0).max(99),
	transferRequest: transferRequestSchema.nullable().default(null),
	artifact: outputArtifactSchema.nullable().default(null),
	error: safeJobErrorSchema.nullable().default(null),
});

export const rejectedJobResponseSchema = z.strictObject({
	contractVersion: z.literal('tracking-provider.v1'),
	outcome: z.literal('rejected'),
	error: safeJobErrorSchema,
});

export type ExecutionIdentity = z.infer<typeof executionIdentitySchema>;
export type PreparedMediaArtifact = z.infer<typeof preparedMediaArtifactSchema>;
export type SubjectProvenance = z.infer<typeof subjectProvenanceSchema>;
export type SubjectObservationSegment = z.infer<
	typeof subjectObservationSegmentSchema
>;
export type SubjectSeed = z.infer<typeof subjectSeedSchema>;
export type TrackingJobSubmission = z.infer<typeof trackingJobSubmissionSchema>;
export type TransferGrantCommand = z.infer<typeof transferGrantCommandSchema>;
export type OutputArtifact = z.infer<typeof outputArtifactSchema>;
export type CancelCommand = z.infer<typeof cancelCommandSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
