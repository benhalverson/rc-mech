import * as z from 'zod/mini';

export type SubjectFrameRequest = Readonly<{
	recordingId: string;
	timestampMs: number;
}>;
export const subjectFrameSchema = z.strictObject({
	recordingId: z.string(),
	requestedTimestampMs: z.int().check(z.nonnegative()),
	frameIndex: z.int().check(z.nonnegative()),
	timestampMs: z.int().check(z.nonnegative()),
	sourceChecksumSha256: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
	contentUrl: z
		.string()
		.check(
			z.regex(
				/^\/api\/v1\/race-videos\/[^/?#]+\/subject-frames\/\d+\/content\?checksum=[0-9a-f]{64}$/,
			),
		),
});
export const subjectFrameResponseSchema = z.strictObject({
	frame: subjectFrameSchema,
});
export type SubjectFrame = z.infer<typeof subjectFrameSchema>;
