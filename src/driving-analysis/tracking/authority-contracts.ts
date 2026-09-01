import { z } from 'zod';
import { sha256Schema, subjectSeedSchema, uuidV4Schema } from './contracts';
import { inferenceProfileSchema } from './inference-profile';

const authorityIdentifierSchema = z
	.string()
	.min(1)
	.max(128)
	.refine(
		(value) =>
			![...value].some((character) => {
				const code = character.charCodeAt(0);
				return code < 0x20 || code === 0x7f;
			}),
	);

const isoTimestampSchema = z.string().datetime();
const positiveIntSchema = z.number().int().positive();
const stableTransferScopeSchema = authorityIdentifierSchema.refine(
	(value) =>
		!value.includes('/') &&
		!value.includes('\\') &&
		!/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(value),
);

const privateObjectKeySchema = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(value) =>
			!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) &&
			!value.includes('\\') &&
			!value.split('/').some((part) => part === '' || part === '..'),
	);

export const createTrackingRunCommandSchema = z.strictObject({
	runId: uuidV4Schema,
	analysisId: authorityIdentifierSchema,
	ownerId: authorityIdentifierSchema,
	sequence: positiveIntSchema,
	workflowId: authorityIdentifierSchema,
	profile: inferenceProfileSchema,
	inputDigest: sha256Schema,
	createdAt: isoTimestampSchema,
});

const initialSegmentSeedSchema = z.strictObject({
	kind: z.literal('initial'),
	sourceId: z.null(),
	value: subjectSeedSchema,
});

const reidentificationSegmentSeedSchema = z.strictObject({
	kind: z.literal('reidentification'),
	sourceId: uuidV4Schema,
	value: subjectSeedSchema,
});

export const createTrackingSegmentCommandSchema = z.strictObject({
	ownerId: authorityIdentifierSchema,
	runId: uuidV4Schema,
	segmentId: uuidV4Schema,
	order: z.number().int().min(0),
	seed: z.discriminatedUnion('kind', [
		initialSegmentSeedSchema,
		reidentificationSegmentSeedSchema,
	]),
	preparedMediaId: uuidV4Schema,
	specificationVersion: z.literal('tracking-segment-spec.v1'),
	availabilityDeadlineAt: positiveIntSchema,
	createdAt: isoTimestampSchema,
});

export const createFirstTrackingSegmentCommandSchema =
	createTrackingSegmentCommandSchema.extend({
		analysisId: authorityIdentifierSchema,
		workflowId: authorityIdentifierSchema,
	});

export const trackingWorkflowIdentitySchema = z.strictObject({
	ownerId: authorityIdentifierSchema,
	analysisId: authorityIdentifierSchema,
	runId: uuidV4Schema,
	workflowId: authorityIdentifierSchema,
	segmentId: uuidV4Schema,
});

export const activateTrackingAttemptCommandSchema = z.strictObject({
	ownerId: authorityIdentifierSchema,
	runId: uuidV4Schema,
	segmentId: uuidV4Schema,
	attemptId: uuidV4Schema,
	leaseId: uuidV4Schema,
	fence: positiveIntSchema,
	expectedCurrentAttemptId: uuidV4Schema.nullable(),
	createdAt: isoTimestampSchema,
});

export const attemptStateSchema = z.enum([
	'proposed',
	'active',
	'transferring',
	'processing',
	'output-ready',
	'completed',
	'failed',
	'cancelled',
	'expired',
	'replaced',
]);

export const transitionTrackingAttemptCommandSchema = z.strictObject({
	ownerId: authorityIdentifierSchema,
	runId: uuidV4Schema,
	segmentId: uuidV4Schema,
	attemptId: uuidV4Schema,
	leaseId: uuidV4Schema,
	fence: positiveIntSchema,
	expectedState: attemptStateSchema,
	nextState: attemptStateSchema,
	progress: z.number().int().min(0).max(99),
	safeFailureCode: authorityIdentifierSchema.nullable(),
	updatedAt: isoTimestampSchema,
});

export const retireTrackingAttemptCommandSchema = z.strictObject({
	ownerId: authorityIdentifierSchema,
	runId: uuidV4Schema,
	segmentId: uuidV4Schema,
	attemptId: uuidV4Schema,
	leaseId: uuidV4Schema,
	fence: positiveIntSchema,
	nextState: z.enum(['expired', 'replaced']),
	updatedAt: isoTimestampSchema,
});

export const recordTrackingTransferRequestCommandSchema = z
	.strictObject({
		ownerId: authorityIdentifierSchema,
		runId: uuidV4Schema,
		segmentId: uuidV4Schema,
		attemptId: uuidV4Schema,
		leaseId: uuidV4Schema,
		fence: positiveIntSchema,
		transferRequestId: uuidV4Schema,
		role: z.enum(['prepared-media', 'frame-manifest', 'observation-artifact']),
		method: z.enum(['GET', 'PUT']),
		objectScope: stableTransferScopeSchema,
		createdAt: isoTimestampSchema,
	})
	.refine(
		(value) =>
			value.method === (value.role === 'observation-artifact' ? 'PUT' : 'GET'),
	);

export const transitionTrackingTransferRequestCommandSchema = z.strictObject({
	ownerId: authorityIdentifierSchema,
	runId: uuidV4Schema,
	segmentId: uuidV4Schema,
	attemptId: uuidV4Schema,
	leaseId: uuidV4Schema,
	fence: positiveIntSchema,
	transferRequestId: uuidV4Schema,
	expectedState: z.enum(['required', 'granted']),
	nextState: z.enum(['granted', 'completed']),
	updatedAt: isoTimestampSchema,
});

export const prepareTrackingTransferGrantCommandSchema = z
	.strictObject({
		ownerId: authorityIdentifierSchema,
		runId: uuidV4Schema,
		segmentId: uuidV4Schema,
		attemptId: uuidV4Schema,
		leaseId: uuidV4Schema,
		fence: positiveIntSchema,
		profileDigest: sha256Schema,
		specificationDigest: sha256Schema,
		transferRequestId: uuidV4Schema,
		role: z.enum(['prepared-media', 'frame-manifest', 'observation-artifact']),
		method: z.enum(['GET', 'PUT']),
		requestedAt: isoTimestampSchema,
	})
	.refine(
		(value) =>
			value.method === (value.role === 'observation-artifact' ? 'PUT' : 'GET'),
	);

export const prepareTrackingArtifactPublicationCommandSchema = z.strictObject({
	ownerId: authorityIdentifierSchema,
	runId: uuidV4Schema,
	segmentId: uuidV4Schema,
	attemptId: uuidV4Schema,
	leaseId: uuidV4Schema,
	fence: positiveIntSchema,
	profileDigest: sha256Schema,
	specificationDigest: sha256Schema,
	transferRequestId: uuidV4Schema,
});

export const recordTrackingArtifactPromotionCommandSchema =
	prepareTrackingArtifactPublicationCommandSchema
		.extend({
			artifactId: uuidV4Schema,
			stagingObjectKey: privateObjectKeySchema,
			acceptedObjectKey: privateObjectKeySchema,
			checksumSha256: sha256Schema,
			contractDigest: sha256Schema,
			byteCount: positiveIntSchema,
			deleteAfter: isoTimestampSchema,
			createdAt: isoTimestampSchema,
		})
		.refine(
			(value) =>
				value.stagingObjectKey ===
					`tracking-staging/${value.attemptId}/${value.transferRequestId}/subject-observations.json.gz` &&
				value.acceptedObjectKey ===
					`tracking-evidence/${value.runId}/${value.segmentId}/${value.attemptId}/subject-observations.json.gz`,
		);

export const markTrackingArtifactPromotionReadyCommandSchema = z.strictObject({
	ownerId: authorityIdentifierSchema,
	runId: uuidV4Schema,
	segmentId: uuidV4Schema,
	attemptId: uuidV4Schema,
	leaseId: uuidV4Schema,
	fence: positiveIntSchema,
	artifactId: uuidV4Schema,
	expectedVersion: positiveIntSchema,
	updatedAt: isoTimestampSchema,
});

export const markTrackingArtifactPromotionDeletedCommandSchema = z.strictObject(
	{
		artifactId: uuidV4Schema,
		expectedVersion: positiveIntSchema,
		deletedAt: isoTimestampSchema,
	},
);

export const trackingGapSchema = z.strictObject({
	startTimestampMs: z.number().int().min(0),
	reason: z.enum(['ambiguous-identity', 'occluded', 'missing']),
});

export const acceptTrackingArtifactCommandSchema = z
	.strictObject({
		ownerId: authorityIdentifierSchema,
		runId: uuidV4Schema,
		segmentId: uuidV4Schema,
		attemptId: uuidV4Schema,
		leaseId: uuidV4Schema,
		fence: positiveIntSchema,
		profileDigest: sha256Schema,
		specificationDigest: sha256Schema,
		transferRequestId: uuidV4Schema,
		artifactId: uuidV4Schema,
		acceptedObjectKey: privateObjectKeySchema,
		checksumSha256: sha256Schema,
		contractDigest: sha256Schema,
		byteCount: positiveIntSchema,
		outcome: z.enum(['completed', 'tracking-gap']),
		gap: trackingGapSchema.nullable(),
		firstTimestampMs: z.number().int().min(0).nullable(),
		lastTimestampMs: z.number().int().min(0).nullable(),
		createdAt: isoTimestampSchema,
	})
	.refine(
		(value) =>
			value.acceptedObjectKey ===
				`tracking-evidence/${value.runId}/${value.segmentId}/${value.attemptId}/subject-observations.json.gz` &&
			(value.outcome === 'tracking-gap') === (value.gap !== null) &&
			((value.firstTimestampMs === null && value.lastTimestampMs === null) ||
				(value.firstTimestampMs !== null &&
					value.lastTimestampMs !== null &&
					value.lastTimestampMs >= value.firstTimestampMs)),
	);

export const fenceTrackingRunCommandSchema = z.strictObject({
	ownerId: authorityIdentifierSchema,
	runId: uuidV4Schema,
	expectedVersion: positiveIntSchema,
	status: z.enum(['cancelled', 'replaced', 'failed']),
	completedAt: isoTimestampSchema,
});

export const publicTrackingProvenanceSchema = z.strictObject({
	runId: uuidV4Schema,
	profileDigest: sha256Schema,
	segments: z.array(
		z.strictObject({
			segmentId: uuidV4Schema,
			order: z.number().int().min(0),
			outcome: z.enum(['completed', 'tracking-gap']).nullable(),
			gap: trackingGapSchema.nullable(),
			artifact: z
				.strictObject({
					artifactId: uuidV4Schema,
					digest: sha256Schema,
					contractDigest: sha256Schema,
					byteCount: positiveIntSchema,
				})
				.nullable(),
		}),
	),
});

export const publicTrackingStateSchema = z.strictObject({
	runId: uuidV4Schema,
	lifecycle: z.enum([
		'queued',
		'running',
		'awaiting-reidentification',
		'completed',
		'failed',
		'cancelled',
	]),
	stage: z.literal('tracking'),
	progress: z.number().int().min(0).max(100),
	waitReason: z
		.enum(['waiting-for-provider', 'waiting-for-capacity'])
		.nullable(),
	safeFailureCode: z
		.enum([
			'TRACKING_PROVIDER_UNAVAILABLE',
			'TRACKING_PROVIDER_FAILED',
			'TRACKING_ARTIFACT_INVALID',
		])
		.nullable(),
});

export type CreateTrackingRunCommand = z.infer<
	typeof createTrackingRunCommandSchema
>;
export type CreateTrackingSegmentCommand = z.infer<
	typeof createTrackingSegmentCommandSchema
>;
export type CreateFirstTrackingSegmentCommand = z.infer<
	typeof createFirstTrackingSegmentCommandSchema
>;
export type TrackingWorkflowIdentity = z.infer<
	typeof trackingWorkflowIdentitySchema
>;
export type ActivateTrackingAttemptCommand = z.infer<
	typeof activateTrackingAttemptCommandSchema
>;
export type TransitionTrackingAttemptCommand = z.infer<
	typeof transitionTrackingAttemptCommandSchema
>;
export type RetireTrackingAttemptCommand = z.infer<
	typeof retireTrackingAttemptCommandSchema
>;
export type RecordTrackingTransferRequestCommand = z.infer<
	typeof recordTrackingTransferRequestCommandSchema
>;
export type TransitionTrackingTransferRequestCommand = z.infer<
	typeof transitionTrackingTransferRequestCommandSchema
>;
export type PrepareTrackingTransferGrantCommand = z.infer<
	typeof prepareTrackingTransferGrantCommandSchema
>;
export type PrepareTrackingArtifactPublicationCommand = z.infer<
	typeof prepareTrackingArtifactPublicationCommandSchema
>;
export type RecordTrackingArtifactPromotionCommand = z.infer<
	typeof recordTrackingArtifactPromotionCommandSchema
>;
export type MarkTrackingArtifactPromotionReadyCommand = z.infer<
	typeof markTrackingArtifactPromotionReadyCommandSchema
>;
export type MarkTrackingArtifactPromotionDeletedCommand = z.infer<
	typeof markTrackingArtifactPromotionDeletedCommandSchema
>;
export type AcceptTrackingArtifactCommand = z.infer<
	typeof acceptTrackingArtifactCommandSchema
>;
export type FenceTrackingRunCommand = z.infer<
	typeof fenceTrackingRunCommandSchema
>;
export type PublicTrackingProvenance = z.infer<
	typeof publicTrackingProvenanceSchema
>;
export type PublicTrackingState = z.infer<typeof publicTrackingStateSchema>;
