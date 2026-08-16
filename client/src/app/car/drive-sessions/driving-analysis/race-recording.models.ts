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
		status: union([literal('uploading'), literal('validating')]),
		uploadedBytes: int().check(
			nonnegative(),
			maximum(MAX_RACE_RECORDING_BYTES),
		),
		uploadedPartNumbers: array(uploadedRaceRecordingPartNumberSchema),
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
			return (
				uploadedBytes === recording.uploadedBytes &&
				(recording.status === 'validating'
					? uploadedBytes === recording.sizeBytes &&
						recording.completedAt !== null
					: recording.completedAt === null)
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
