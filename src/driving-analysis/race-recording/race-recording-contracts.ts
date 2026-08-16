import { z } from 'zod';

export const RACE_RECORDING_PART_SIZE = 10 * 1024 * 1024;
export const MAX_RACE_RECORDING_BYTES = 10 * 1024 * 1024 * 1024;
export const MAX_ACTIVE_RACE_RECORDINGS_PER_OWNER = 2;
export const MAX_ACTIVE_RACE_RECORDING_BYTES_PER_OWNER =
	20 * 1024 * 1024 * 1024;
export const MAX_RETAINED_RACE_RECORDING_BYTES_PER_OWNER =
	100 * 1024 * 1024 * 1024;
export const MAX_RACE_RECORDING_CREATIONS_PER_HOUR = 10;
export const RACE_RECORDING_CREATION_WINDOW_MS = 60 * 60 * 1000;
export const RACE_RECORDING_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const supportedRaceRecordingContentTypes = [
	'video/mp4',
	'video/quicktime',
	'video/webm',
] as const;

export const createRaceRecordingInputSchema = z
	.object({
		fileName: z.string().trim().min(1).max(255),
		contentType: z.enum(supportedRaceRecordingContentTypes),
		sizeBytes: z.number().int().positive().max(MAX_RACE_RECORDING_BYTES),
		requestId: z.string().uuid(),
	})
	.strict();

export const raceRecordingPartRequestSchema = z
	.object({
		partNumber: z.coerce.number().int().positive().max(10_000),
		transferRequestId: z.string().trim().min(1).max(200),
	})
	.strict();

export type CreateRaceRecordingInput = z.infer<
	typeof createRaceRecordingInputSchema
>;

export type PublicRaceRecording = Readonly<{
	id: string;
	carId: string;
	driveSessionId: string;
	fileName: string;
	contentType: (typeof supportedRaceRecordingContentTypes)[number];
	sizeBytes: number;
	partSizeBytes: number;
	status: 'uploading' | 'validating';
	uploadedBytes: number;
	uploadedPartNumbers: readonly number[];
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
	completedAt: string | null;
}>;
