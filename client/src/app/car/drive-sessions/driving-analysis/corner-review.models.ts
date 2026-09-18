import * as z from 'zod/mini';

const nonnegative = z.number().check(z.minimum(0));
const index = z.int().check(z.minimum(0));
const digest = z.string().check(z.regex(/^[a-f0-9]{64}$/));
const crossing = z.strictObject({
	timestampMs: nonnegative,
	beforeFrameIndex: index,
	afterFrameIndex: index,
});
const passFields = {
	cornerId: z.string(),
	cornerKey: z.string(),
	cornerOrder: index,
	ordinal: z.int().check(z.minimum(1)),
	provenance: z.strictObject({
		segmentId: z.string(),
		segmentSequence: index,
		profileDigest: digest,
		observationChecksum: digest,
		manifestChecksum: digest,
		measurementVersion: z.literal('corner-evidence.v1'),
		measurementDigest: digest,
	}),
};
const pass = z.discriminatedUnion('eligibility', [
	z
		.strictObject({
			...passFields,
			eligibility: z.literal('eligible'),
			entry: crossing,
			exit: crossing,
			durationMs: nonnegative,
			exclusionReason: z.null(),
			rank: z.int().check(z.minimum(1)),
			tieGroup: z.int().check(z.minimum(1)),
			best: z.boolean(),
		})
		.check(
			z.refine(
				(value) =>
					value.tieGroup === value.rank && value.best === (value.rank === 1),
			),
		),
	z.strictObject({
		...passFields,
		eligibility: z.literal('ineligible'),
		entry: z.nullable(crossing),
		exit: z.nullable(crossing),
		durationMs: z.null(),
		exclusionReason: z.enum([
			'tracking-gap',
			'untrusted-crossing',
			'gate-order',
			'race-window',
		]),
		rank: z.null(),
		tieGroup: z.null(),
		best: z.literal(false),
	}),
]);

export const cornerReviewResponseSchema = z.strictObject({
	evidence: z.strictObject({
		analysisId: z.string(),
		carId: z.string(),
		driveSessionId: z.string(),
		stateVersion: z.int().check(z.minimum(1)),
		status: z.enum([
			'queued',
			'running',
			'awaiting-reidentification',
			'completed',
			'failed',
			'cancelled',
		]),
		runId: z.nullable(z.string()),
		trackMapVersionId: z.string(),
		tieToleranceMs: z.nullable(nonnegative),
		corners: z.array(
			z.strictObject({
				id: z.string(),
				name: z.string(),
				order: index,
				passes: z.array(pass),
			}),
		),
	}),
});

export type CornerReview = z.infer<
	typeof cornerReviewResponseSchema
>['evidence'];
export type ReviewedPass = CornerReview['corners'][number]['passes'][number];

export const exclusionReasonLabel = (
	reason: NonNullable<ReviewedPass['exclusionReason']>,
): string =>
	({
		'tracking-gap': 'Tracking lost the Subject car during this pass.',
		'untrusted-crossing': 'The gate crossing could not be trusted.',
		'gate-order': 'Entry and exit gates were crossed out of order.',
		'race-window': 'The pass extends beyond the selected Race window.',
	})[reason];
