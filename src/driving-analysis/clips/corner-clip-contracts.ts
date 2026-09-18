import { z } from 'zod';
import {
	safeIdentifierSchema as identifier,
	normalizedBoxSchema,
	uuidV4Schema as uuid,
} from '../tracking/contracts';
import { asPythonFloat, pythonCanonical } from '../tracking/python-canonical';

export const MAX_CLIP_BYTES = 16 * 1024 * 1024;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const coordinate = z.number().finite().min(0).max(1);
const point = z.strictObject({ x: coordinate, y: coordinate });
const gate = z
	.strictObject({
		entry: point,
		exit: point,
		direction: z.enum(['positive', 'negative']),
	})
	.refine(
		(value) => value.entry.x !== value.exit.x || value.entry.y !== value.exit.y,
	);
export const clipSpecificationSchema = z
	.strictObject({
		sourceChecksumSha256: digest,
		runId: identifier,
		trackMapVersion: identifier,
		cornerId: identifier,
		cornerView: normalizedBoxSchema,
		entryTimestampMs: z.number().int().nonnegative().max(86_400_000),
		exitTimestampMs: z.number().int().positive().max(86_400_000),
		padding: z.strictObject({
			beforeMs: z.literal(500),
			afterMs: z.literal(500),
		}),
		overlay: z.strictObject({
			subjectCenter: point,
			entryGate: gate,
			exitGate: gate,
		}),
		maxOutputBytes: z.number().int().positive().max(MAX_CLIP_BYTES),
		pipelineVersion: z.literal('corner-render.v1'),
	})
	.refine(
		(value) =>
			value.exitTimestampMs > value.entryTimestampMs &&
			value.exitTimestampMs - value.entryTimestampMs + 1000 <= 900_000,
	);

export const clipRequestSchema = z.strictObject({
	contractVersion: z.literal('corner-render.v1'),
	correlationId: uuid,
	caseId: identifier,
	renderId: uuid,
	input: z.strictObject({
		stagedMediaId: uuid,
		expectedByteCount: z.number().int().positive().safe(),
	}),
	specification: clipSpecificationSchema,
});
export const clipArtifactSchema = z.strictObject({
	renderId: uuid,
	caseId: identifier,
	contentType: z.literal('video/mp4'),
	byteCount: z.number().int().positive().max(MAX_CLIP_BYTES),
	checksumSha256: digest,
	durationMs: z.number().int().positive().max(900_000),
	renderInputDigest: digest,
	sourceChecksumSha256: digest,
	ffmpegVersion: identifier,
	pipelineVersion: z.literal('corner-render.v1'),
	elapsedMs: z.number().int().nonnegative().safe(),
});
export const clipResponseSchema = z.discriminatedUnion('outcome', [
	z.strictObject({
		contractVersion: z.literal('corner-render.v1'),
		correlationId: uuid,
		outcome: z.literal('accepted'),
		caseId: identifier,
		artifact: clipArtifactSchema,
	}),
	z.strictObject({
		contractVersion: z.literal('corner-render.v1'),
		correlationId: uuid.nullable(),
		outcome: z.literal('rejected'),
		caseId: identifier.nullable(),
		error: z.strictObject({
			code: z.enum([
				'INVALID_REQUEST',
				'MEDIA_UNAVAILABLE',
				'RENDER_FAILED',
				'PROCESS_TIMEOUT',
				'RESOURCE_LIMIT',
				'ARTIFACT_CONFLICT',
				'SERVICE_BUSY',
			]),
			stage: z.enum(['request', 'render', 'serialize', 'admission']),
			message: z.enum([
				'render request rejected',
				'render media unavailable',
				'Corner clip rendering failed safely',
				'render exceeded its time limit',
				'render output exceeded its limit',
				'immutable render artifact already exists',
				'render service is busy',
			]),
		}),
	}),
]);
export type ClipRequest = z.infer<typeof clipRequestSchema>;
export type ClipArtifact = z.infer<typeof clipArtifactSchema>;
export type ClipSpecification = z.infer<typeof clipSpecificationSchema>;

export const clipSha256 = async (bytes: Uint8Array): Promise<string> =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');

const pythonPoint = (value: { x: number; y: number }) => ({
	x: asPythonFloat(value.x),
	y: asPythonFloat(value.y),
});
const pythonGate = (value: ClipSpecification['overlay']['entryGate']) => ({
	entry: pythonPoint(value.entry),
	exit: pythonPoint(value.exit),
	direction: value.direction,
});
export const clipSpecificationCanonical = (
	specification: ClipSpecification,
) => ({
	...specification,
	cornerView: {
		...pythonPoint(specification.cornerView),
		width: asPythonFloat(specification.cornerView.width),
		height: asPythonFloat(specification.cornerView.height),
	},
	overlay: {
		subjectCenter: pythonPoint(specification.overlay.subjectCenter),
		entryGate: pythonGate(specification.overlay.entryGate),
		exitGate: pythonGate(specification.overlay.exitGate),
	},
});
export const clipRenderDigest = (
	request: ClipRequest,
	ffmpegVersion: string,
): Promise<string> =>
	clipSha256(
		new TextEncoder().encode(
			`${pythonCanonical({
				contractVersion: request.contractVersion,
				caseId: request.caseId,
				renderId: request.renderId,
				expectedByteCount: request.input.expectedByteCount,
				specification: clipSpecificationCanonical(request.specification),
				ffmpegVersion,
			})}\n`,
		),
	);
