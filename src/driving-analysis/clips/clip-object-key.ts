import { z } from 'zod';

const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const identitySchema = z.strictObject({
	ownerId: opaqueId,
	analysisId: opaqueId,
	runId: opaqueId,
	inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Shared by publication and lifecycle cleanup; never accepts user-chosen paths. */
export const cornerClipObjectKey = (
	identity: z.infer<typeof identitySchema>,
): string => {
	const { ownerId, analysisId, runId, inputDigest } =
		identitySchema.parse(identity);
	return `corner-clips/${ownerId}/${analysisId}/${runId}/${inputDigest}.mp4`;
};
