import { z } from 'zod';
import { sha256Schema, uuidV4Schema } from '../tracking/contracts';

export const MAX_SUBJECT_FRAME_BYTES = 8 * 1024 * 1024;
export const sourceFrameSelectionSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('timestamp'),
		timestampMs: z.number().int().nonnegative().safe(),
	}),
	z.strictObject({
		kind: z.literal('frame'),
		frameIndex: z.number().int().nonnegative().safe(),
	}),
]);
export const sourceFrameRequestSchema = z.strictObject({
	contractVersion: z.literal('source-frame.v1'),
	input: z.strictObject({
		stagedMediaId: uuidV4Schema,
		expectedByteCount: z
			.number()
			.int()
			.positive()
			.max(50 * 1024 ** 3),
	}),
	sourceChecksumSha256: sha256Schema,
	selection: sourceFrameSelectionSchema,
	includeImage: z.boolean(),
});
export const sourceFrameResponseSchema = z.strictObject({
	contractVersion: z.literal('source-frame.v1'),
	frameIndex: z.number().int().nonnegative().safe(),
	timestampMs: z.number().int().nonnegative().safe(),
	sourceChecksumSha256: sha256Schema,
	imageBase64: z
		.string()
		.max(Math.ceil(MAX_SUBJECT_FRAME_BYTES / 3) * 4)
		.nullable(),
});
export const sourceFrameErrorResponseSchema = z.strictObject({
	contractVersion: z.literal('source-frame.v1'),
	error: z.strictObject({
		code: z.enum([
			'INVALID_REQUEST',
			'SERVICE_BUSY',
			'PROCESS_TIMEOUT',
			'RESOURCE_LIMIT',
			'FRAME_UNAVAILABLE',
			'SOURCE_MISMATCH',
		]),
		message: z.literal('source frame selection rejected'),
	}),
});
export const sourceFrameCommandSchema = z.strictObject({
	source: z.strictObject({
		objectKey: z
			.string()
			.regex(/^race-recordings\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/),
		byteCount: z
			.number()
			.int()
			.positive()
			.max(50 * 1024 ** 3),
		checksumSha256: sha256Schema,
	}),
	selection: sourceFrameSelectionSchema,
	includeImage: z.boolean(),
});
export type SourceFrameCommand = z.infer<typeof sourceFrameCommandSchema>;
export type SourceFrameResult = z.infer<typeof sourceFrameResponseSchema>;
