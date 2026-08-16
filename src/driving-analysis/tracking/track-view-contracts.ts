import { z } from 'zod';
import {
	preparedMediaArtifactSchema,
	raceWindowSchema,
	sha256Schema,
	uuidV4Schema,
} from './contracts';

export const PREPARED_MEDIA_CONTENT_TYPE = 'video/mp4' as const;
export const FRAME_MANIFEST_CONTENT_TYPE =
	'application/vnd.rc-mech.prepared-frame-manifest+json' as const;

const MAX_TIMESTAMP_MS = 86_400_000;
const MAX_FRAME_COUNT = 10_000_000;
const safeIdentifierSchema = z
	.string()
	.min(1)
	.max(128)
	.refine((value) =>
		[...value].every((character) => {
			const code = character.charCodeAt(0);
			return code >= 0x20 && code !== 0x7f;
		}),
	);
const privateObjectKeySchema = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(value) =>
			!value.startsWith('/') &&
			!value.includes('\\') &&
			!value.split('/').includes('..') &&
			!/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(value),
	);
const positiveIntSchema = z.number().int().positive();
const isoTimestampSchema = z.string().datetime();

const fixedTrackViewSchema = z
	.strictObject({
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
		width: z.number().positive().max(1),
		height: z.number().positive().max(1),
	})
	.refine(
		(value) =>
			value.x === 0 &&
			value.y === 1 / 3 &&
			value.width === 1 &&
			value.height === 2 / 3,
	);

export const trackingRunInputSchema = z.strictObject({
	contractVersion: z.literal('tracking-run-input.v1'),
	runId: uuidV4Schema,
	raceVideoId: uuidV4Schema,
	sourceObjectKey: privateObjectKeySchema,
	sourceByteCount: positiveIntSchema,
	sourceChecksumSha256: sha256Schema,
	window: raceWindowSchema,
	approvedTrackMapVersionId: uuidV4Schema,
	sourceLayout: z.strictObject({
		version: z.literal('fixed-track-view.v1'),
		digest: sha256Schema,
		width: positiveIntSchema,
		height: positiveIntSchema,
		trackView: fixedTrackViewSchema,
	}),
});

export const pinTrackingRunInputCommandSchema = z.strictObject({
	ownerId: safeIdentifierSchema,
	input: trackingRunInputSchema,
	createdAt: isoTimestampSchema,
});

const stagedMediaInputSchema = z.strictObject({
	stagedMediaId: uuidV4Schema,
	expectedByteCount: positiveIntSchema,
});

export const prepareStageRequestSchema = z.strictObject({
	contractVersion: z.literal('subject-tracking.v1'),
	correlationId: uuidV4Schema,
	caseId: safeIdentifierSchema,
	preparedMediaId: uuidV4Schema,
	input: stagedMediaInputSchema,
	window: raceWindowSchema,
	pipelineVersion: z.literal('subject-tracking.v1'),
});

const processingErrors = {
	INVALID_REQUEST: ['request', 'processing request rejected'],
	MEDIA_UNAVAILABLE: ['prepare', 'processing media unavailable'],
	PREPARATION_FAILED: ['prepare', 'Race window preparation failed safely'],
	INFERENCE_UNAVAILABLE: ['initialize', 'inference provider unavailable'],
	INFERENCE_FAILED: ['track', 'inference failed safely'],
	RESOURCE_LIMIT: ['serialize', 'processing resource limit exceeded'],
	ARTIFACT_CONFLICT: ['serialize', 'immutable artifact already exists'],
	SERVICE_BUSY: ['admission', 'processing service is busy'],
} as const;

const processingSafeErrorSchema = z
	.strictObject({
		code: z.enum([
			'INVALID_REQUEST',
			'MEDIA_UNAVAILABLE',
			'PREPARATION_FAILED',
			'PROCESS_TIMEOUT',
			'INFERENCE_UNAVAILABLE',
			'INFERENCE_FAILED',
			'RESOURCE_LIMIT',
			'ARTIFACT_CONFLICT',
			'SERVICE_BUSY',
		]),
		stage: z.enum([
			'request',
			'prepare',
			'initialize',
			'track',
			'serialize',
			'admission',
		]),
		message: z.enum([
			'processing request rejected',
			'processing media unavailable',
			'Race window preparation failed safely',
			'processing exceeded its time limit',
			'inference provider unavailable',
			'inference failed safely',
			'processing resource limit exceeded',
			'immutable artifact already exists',
			'processing service is busy',
		]),
	})
	.refine((value) => {
		if (value.code === 'PROCESS_TIMEOUT')
			return (
				(value.stage === 'prepare' || value.stage === 'track') &&
				value.message === 'processing exceeded its time limit'
			);
		const expected = processingErrors[value.code];
		return value.stage === expected[0] && value.message === expected[1];
	});

const prepareStageAcceptedSchema = z.strictObject({
	contractVersion: z.literal('subject-tracking.v1'),
	correlationId: uuidV4Schema,
	outcome: z.literal('accepted'),
	caseId: safeIdentifierSchema,
	prepared: preparedMediaArtifactSchema,
});

const prepareStageRejectedSchema = z.strictObject({
	contractVersion: z.literal('subject-tracking.v1'),
	correlationId: uuidV4Schema.nullable(),
	outcome: z.literal('rejected'),
	caseId: safeIdentifierSchema.nullable(),
	error: processingSafeErrorSchema,
});

export const prepareStageResponseSchema = z.discriminatedUnion('outcome', [
	prepareStageAcceptedSchema,
	prepareStageRejectedSchema,
]);

const preparedFrameSchema = z.strictObject({
	preparedFrameIndex: z.number().int().min(0).lt(MAX_FRAME_COUNT),
	frameIndex: z.number().int().min(0).lt(MAX_FRAME_COUNT),
	timestampMs: z.number().int().min(0).max(MAX_TIMESTAMP_MS),
});

export const preparedFrameManifestSchema = z
	.strictObject({
		contractVersion: z.literal('subject-tracking.v1'),
		preparedMediaId: uuidV4Schema,
		caseId: safeIdentifierSchema,
		sourceChecksumSha256: sha256Schema,
		sourceByteCount: positiveIntSchema,
		window: raceWindowSchema,
		trackView: fixedTrackViewSchema,
		mediaByteCount: positiveIntSchema,
		mediaChecksumSha256: sha256Schema,
		width: positiveIntSchema,
		height: positiveIntSchema,
		averageFrameRate: z.strictObject({
			numerator: z.number().int(),
			denominator: positiveIntSchema,
		}),
		ffmpegVersion: safeIdentifierSchema,
		pipelineVersion: z.literal('subject-tracking.v1'),
		preparationInputDigest: sha256Schema,
		preparationConfigurationDigest: sha256Schema,
		frames: z.array(preparedFrameSchema).min(1).max(MAX_FRAME_COUNT),
	})
	.refine((value) => value.frames[0]?.preparedFrameIndex === 0)
	.refine((value) =>
		value.frames.every((frame, index) => {
			if (index === 0) return true;
			const previous = value.frames[index - 1];
			return (
				previous !== undefined &&
				frame.preparedFrameIndex === previous.preparedFrameIndex + 1 &&
				frame.frameIndex > previous.frameIndex &&
				frame.timestampMs > previous.timestampMs
			);
		}),
	)
	.refine((value) =>
		value.frames.every(
			(frame) =>
				frame.timestampMs >= value.window.startTimestampMs &&
				frame.timestampMs < value.window.endTimestampMs,
		),
	);

export const preparedTrackViewObjectSchema = z.strictObject({
	role: z.enum(['prepared-media', 'frame-manifest']),
	objectKey: privateObjectKeySchema,
	byteCount: positiveIntSchema,
	checksumSha256: sha256Schema,
	contentType: z.enum([
		PREPARED_MEDIA_CONTENT_TYPE,
		FRAME_MANIFEST_CONTENT_TYPE,
	]),
	contentEncoding: z.enum(['gzip']).nullable(),
});

export const acceptPreparedTrackViewCommandSchema = z.strictObject({
	ownerId: safeIdentifierSchema,
	runId: uuidV4Schema,
	expectedRunVersion: positiveIntSchema,
	expectedInputDigest: sha256Schema,
	descriptor: preparedMediaArtifactSchema,
	objects: z.array(preparedTrackViewObjectSchema).length(2),
	deleteAfter: isoTimestampSchema,
	createdAt: isoTimestampSchema,
});

export const markPreparedTrackViewDeletedCommandSchema = z.strictObject({
	ownerId: safeIdentifierSchema,
	runId: uuidV4Schema,
	preparedMediaId: uuidV4Schema,
	expectedVersion: positiveIntSchema,
	deletedAt: isoTimestampSchema,
});

export type TrackingRunInput = z.infer<typeof trackingRunInputSchema>;
export type PinTrackingRunInputCommand = z.infer<
	typeof pinTrackingRunInputCommandSchema
>;
export type PrepareStageRequest = z.infer<typeof prepareStageRequestSchema>;
export type PrepareStageResponse = z.infer<typeof prepareStageResponseSchema>;
export type PreparedFrameManifest = z.infer<typeof preparedFrameManifestSchema>;
export type PreparedTrackViewObject = z.infer<
	typeof preparedTrackViewObjectSchema
>;
export type AcceptPreparedTrackViewCommand = z.infer<
	typeof acceptPreparedTrackViewCommandSchema
>;
export type MarkPreparedTrackViewDeletedCommand = z.infer<
	typeof markPreparedTrackViewDeletedCommandSchema
>;
