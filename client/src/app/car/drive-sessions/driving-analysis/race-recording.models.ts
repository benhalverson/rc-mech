import type * as z from 'zod/mini';
import {
	array,
	int,
	literal,
	maximum,
	maxLength,
	minLength,
	nonnegative,
	nullable,
	object,
	optional,
	pipe,
	positive,
	readonly,
	refine,
	string,
	transform,
	union,
} from 'zod/mini';

export const RACE_RECORDING_PART_SIZE = 10 * 1024 * 1024;
export const MAX_RACE_RECORDING_BYTES = 10 * 1024 * 1024 * 1024;
export const SUPPORTED_RACE_RECORDING_TYPES = [
	'video/mp4',
	'video/quicktime',
	'video/webm',
] as const;
const MAX_RACE_RECORDING_PARTS = Math.ceil(
	MAX_RACE_RECORDING_BYTES / RACE_RECORDING_PART_SIZE,
);

export const uploadedRaceRecordingPartNumberSchema = int().check(
	positive(),
	maximum(MAX_RACE_RECORDING_PARTS),
);

const rationalValueSchema = object({
	numerator: int(),
	denominator: int().check(positive()),
});

const raceVideoMediaFactsSchema = object({
	byteCount: int().check(positive(), maximum(MAX_RACE_RECORDING_BYTES)),
	durationMs: int().check(positive()),
	width: int().check(positive()),
	height: int().check(positive()),
	videoCodec: string().check(minLength(1), maxLength(32)),
	audioCodecs: array(string().check(minLength(1), maxLength(32))).check(
		maxLength(8),
	),
	containerFormats: array(string().check(minLength(1), maxLength(32))).check(
		minLength(1),
		maxLength(8),
	),
	decodedFrameCount: int().check(positive()),
	averageFrameRate: rationalValueSchema,
	timeBase: rationalValueSchema,
	sampleAspectRatio: rationalValueSchema,
	displayAspectRatio: rationalValueSchema,
	startTimeMs: int(),
	checksumSha256: string().check(
		refine((value) => /^[0-9a-f]{64}$/.test(value)),
	),
});

const raceVideoValidationErrorSchema = object({
	code: union([
		literal('INVALID_REQUEST'),
		literal('SERVICE_UNAVAILABLE'),
		literal('STAGED_MEDIA_NOT_FOUND'),
		literal('STAGED_MEDIA_MISMATCH'),
		literal('CORRUPT_MEDIA'),
		literal('UNSUPPORTED_MEDIA'),
		literal('MEDIA_OVER_LIMIT'),
		literal('PROCESS_TIMEOUT'),
		literal('INCOMPATIBLE_LAYOUT'),
		literal('INTERNAL_ERROR'),
		literal('SERVICE_BUSY'),
	]),
	stage: union([
		literal('request'),
		literal('claim'),
		literal('inspect'),
		literal('probe'),
		literal('decode'),
		literal('cleanup'),
		literal('admission'),
	]),
	message: string().check(
		minLength(1),
		maxLength(160),
		refine(
			(value) =>
				!value.includes('://') &&
				!value.toLowerCase().includes('www.') &&
				![...value].some((character) => {
					const code = character.charCodeAt(0);
					return code < 0x20 || code === 0x7f;
				}),
		),
	),
});

export const raceRecordingSchema = readonly(
	object({
		id: string().check(minLength(1)),
		carId: string().check(minLength(1)),
		driveSessionId: string().check(minLength(1)),
		fileName: string().check(minLength(1), maxLength(255)),
		contentType: union([
			literal('video/mp4'),
			literal('video/quicktime'),
			literal('video/webm'),
		]),
		sizeBytes: int().check(positive(), maximum(MAX_RACE_RECORDING_BYTES)),
		partSizeBytes: literal(RACE_RECORDING_PART_SIZE),
		status: union([
			literal('uploading'),
			literal('validating'),
			literal('ready'),
			literal('invalid'),
		]),
		uploadedBytes: int().check(
			nonnegative(),
			maximum(MAX_RACE_RECORDING_BYTES),
		),
		uploadedPartNumbers: array(uploadedRaceRecordingPartNumberSchema),
		validationStateVersion: nullable(int().check(positive())),
		media: nullable(raceVideoMediaFactsSchema),
		validationError: nullable(raceVideoValidationErrorSchema),
		validatedAt: nullable(string().check(minLength(1))),
		playbackUrl: nullable(string().check(minLength(1))),
		createdAt: string().check(minLength(1)),
		updatedAt: string().check(minLength(1)),
		expiresAt: string().check(minLength(1)),
		completedAt: nullable(string().check(minLength(1))),
	}).check(
		refine((recording) => {
			const partCount = Math.ceil(
				recording.sizeBytes / recording.partSizeBytes,
			);
			const parts = new Set(recording.uploadedPartNumbers);
			if (
				parts.size !== recording.uploadedPartNumbers.length ||
				recording.uploadedPartNumbers.some(
					(partNumber) => partNumber > partCount,
				)
			)
				return false;
			const uploadedBytes = recording.uploadedPartNumbers.reduce(
				(total, partNumber) =>
					total +
					(partNumber < partCount
						? recording.partSizeBytes
						: recording.sizeBytes - recording.partSizeBytes * (partCount - 1)),
				0,
			);
			if (uploadedBytes !== recording.uploadedBytes) return false;
			if (recording.status === 'uploading')
				return (
					recording.completedAt === null &&
					recording.validationStateVersion === null &&
					recording.media === null &&
					recording.validationError === null &&
					recording.validatedAt === null &&
					recording.playbackUrl === null
				);
			if (
				uploadedBytes !== recording.sizeBytes ||
				recording.completedAt === null ||
				recording.validationStateVersion === null
			)
				return false;
			if (recording.status === 'validating')
				return (
					recording.media === null &&
					recording.validationError === null &&
					recording.validatedAt === null &&
					recording.playbackUrl === null
				);
			if (recording.status === 'ready')
				return (
					recording.media !== null &&
					recording.validationError === null &&
					recording.validatedAt !== null &&
					recording.playbackUrl ===
						`/api/v1/race-videos/${encodeURIComponent(recording.id)}/content`
				);
			return (
				recording.media === null &&
				recording.validationError !== null &&
				recording.validatedAt !== null &&
				recording.playbackUrl === null
			);
		}),
	),
);

export const raceRecordingCollectionSchema = pipe(
	object({ raceVideos: optional(array(raceRecordingSchema)) }),
	transform((value) => value.raceVideos ?? []),
);

export const raceRecordingMutationSchema = pipe(
	object({ raceVideo: raceRecordingSchema }),
	transform((value) => value.raceVideo),
);

export type RaceRecording = z.infer<typeof raceRecordingSchema>;
export type RaceRecordingCollection = z.infer<
	typeof raceRecordingCollectionSchema
>;

export type RaceRecordingGatewayFailure =
	| { readonly kind: 'http'; readonly status: number }
	| {
			readonly kind: 'rejected-response';
			readonly status: number;
			readonly message: string;
	  }
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'invalid-response' }
	| { readonly kind: 'file-required' };

export type StartRaceRecordingCommand = Readonly<{
	carId: string;
	driveSessionId: string;
	file: File;
}>;

export type RaceRecordingIdentity = Readonly<{
	carId: string;
	driveSessionId: string;
	recordingId: string;
}>;

export type RaceRecordingTransferEvent =
	| Readonly<{ kind: 'progress'; loaded: number; total: number }>
	| Readonly<{ kind: 'completed'; recording: RaceRecording }>;

export type RaceRecordingTransferStatus =
	| 'idle'
	| 'uploading'
	| 'paused'
	| 'cancelling'
	| 'complete'
	| 'failed';

export type RaceRecordingTransferState = Readonly<{
	status: RaceRecordingTransferStatus;
	driveSessionId: string | null;
	recordingId: string | null;
	uploadedBytes: number;
	totalBytes: number;
	error: RaceRecordingGatewayFailure | null;
}>;

export const idleRaceRecordingTransfer = (): RaceRecordingTransferState => ({
	status: 'idle',
	driveSessionId: null,
	recordingId: null,
	uploadedBytes: 0,
	totalBytes: 0,
	error: null,
});
