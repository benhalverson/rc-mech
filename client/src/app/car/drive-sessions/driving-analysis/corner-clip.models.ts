import * as z from 'zod/mini';

export const cornerClipSchema = z.strictObject({
	id: z.string(),
	cornerId: z.string(),
	ordinal: z.int(),
	segmentId: z.string(),
	status: z.enum(['ready', 'not-ready']),
	inputDigest: z.string(),
	checksum: z.nullable(z.string()),
	durationMs: z.nullable(z.number()),
	pipelineVersion: z.literal('corner-render.v1'),
});
export const cornerClipsSchema = z.strictObject({
	clips: z.array(cornerClipSchema),
});
export type CornerClipArtifact = z.infer<typeof cornerClipSchema>;
