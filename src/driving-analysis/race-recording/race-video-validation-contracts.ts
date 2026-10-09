import { z } from 'zod';

export const RACE_VIDEO_VALIDATION_CONTRACT_VERSION =
	'race-video-validation.v1' as const;
export const MAX_RACE_VIDEO_VALIDATION_RESPONSE_BYTES = 16 * 1024;

const uuidV4Schema = z
	.string()
	.regex(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
const safeIntegerSchema = z.number().int().safe();
const positiveSafeIntegerSchema = safeIntegerSchema.positive();
const boundedIdentifierSchema = z
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
const boundedCodecSchema = z.string().min(1).max(32);
const safeMessageSchema = z
	.string()
	.min(1)
	.max(160)
	.refine(
		(value) =>
			!value.includes('://') &&
			!value.toLowerCase().includes('www.') &&
			![...value].some((character) => {
				const code = character.charCodeAt(0);
				return code < 0x20 || code === 0x7f;
			}),
	);

export const raceVideoValidationErrorCodeSchema = z.enum([
	'INVALID_REQUEST',
	'SERVICE_UNAVAILABLE',
	'STAGED_MEDIA_NOT_FOUND',
	'STAGED_MEDIA_MISMATCH',
	'CORRUPT_MEDIA',
	'UNSUPPORTED_MEDIA',
	'MEDIA_OVER_LIMIT',
	'PROCESS_TIMEOUT',
	'INCOMPATIBLE_LAYOUT',
	'INTERNAL_ERROR',
	'SERVICE_BUSY',
]);

export const raceVideoValidationErrorStageSchema = z.enum([
	'request',
	'claim',
	'inspect',
	'probe',
	'decode',
	'cleanup',
	'admission',
]);

export const raceVideoValidationSafeErrorSchema = z.strictObject({
	code: raceVideoValidationErrorCodeSchema,
	stage: raceVideoValidationErrorStageSchema,
	message: safeMessageSchema,
});

const rationalValueSchema = z.strictObject({
	numerator: safeIntegerSchema,
	denominator: positiveSafeIntegerSchema,
});

export const raceVideoMediaFactsSchema = z.strictObject({
	byteCount: positiveSafeIntegerSchema,
	durationMs: positiveSafeIntegerSchema,
	width: positiveSafeIntegerSchema,
	height: positiveSafeIntegerSchema,
	videoCodec: boundedCodecSchema,
	audioCodecs: z.array(boundedCodecSchema).max(8),
	containerFormats: z.array(boundedCodecSchema).min(1).max(8),
	decodedFrameCount: positiveSafeIntegerSchema,
	averageFrameRate: rationalValueSchema,
	timeBase: rationalValueSchema,
	sampleAspectRatio: rationalValueSchema,
	displayAspectRatio: rationalValueSchema,
	startTimeMs: safeIntegerSchema,
	checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type RaceVideoPlaybackContentType =
	| 'video/mp4'
	| 'video/quicktime'
	| 'video/webm';

const mp4ContainerFormats = new Set(['3g2', '3gp', 'm4a', 'mj2', 'mp4']);

export const raceVideoPlaybackContentType = (
	media: RaceVideoMediaFacts,
): RaceVideoPlaybackContentType | null => {
	if (media.containerFormats.includes('webm')) return 'video/webm';
	if (media.containerFormats.some((format) => mp4ContainerFormats.has(format)))
		return 'video/mp4';
	if (media.containerFormats.includes('mov')) return 'video/quicktime';
	return null;
};

const acceptedValidationResponseSchema = z.strictObject({
	contractVersion: z.literal(RACE_VIDEO_VALIDATION_CONTRACT_VERSION),
	correlationId: uuidV4Schema,
	outcome: z.literal('accepted'),
	media: raceVideoMediaFactsSchema,
});

const rejectedValidationResponseSchema = z.strictObject({
	contractVersion: z.literal(RACE_VIDEO_VALIDATION_CONTRACT_VERSION),
	correlationId: uuidV4Schema.nullable(),
	outcome: z.literal('rejected'),
	error: raceVideoValidationSafeErrorSchema,
});

export const raceVideoValidationResponseSchema = z.discriminatedUnion(
	'outcome',
	[acceptedValidationResponseSchema, rejectedValidationResponseSchema],
);

export const raceVideoValidationWorkflowPayloadSchema = z.strictObject({
	ownerId: boundedIdentifierSchema,
	recordingId: uuidV4Schema,
	validationId: uuidV4Schema,
	expectedStateVersion: positiveSafeIntegerSchema,
});

export const raceVideoValidationRequest = (command: {
	validationId: string;
	expectedByteCount: number;
}) => ({
	contractVersion: RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
	correlationId: command.validationId,
	input: {
		stagedMediaId: command.validationId,
		expectedByteCount: command.expectedByteCount,
	},
});

export type RaceVideoMediaFacts = z.infer<typeof raceVideoMediaFactsSchema>;
export type RaceVideoValidationResponse = z.infer<
	typeof raceVideoValidationResponseSchema
>;
export type RaceVideoValidationSafeError = z.infer<
	typeof raceVideoValidationSafeErrorSchema
>;
export type RaceVideoValidationWorkflowPayload = z.infer<
	typeof raceVideoValidationWorkflowPayloadSchema
>;
