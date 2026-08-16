import { z } from 'zod';
import { sha256Schema } from './contracts';

const profileIdentifier = z.string().min(1).max(128);

export const inferenceProfileSchema = z.strictObject({
	contractVersion: z.literal('inference-profile.v1'),
	canonicalizationVersion: z.literal('inference-profile-c14n.v1'),
	provider: z.literal('local-sam31'),
	model: z.strictObject({
		name: z.literal('sam3.1'),
		version: profileIdentifier,
		digest: sha256Schema,
	}),
	pipeline: z.strictObject({
		version: profileIdentifier,
		digest: sha256Schema,
	}),
	runtimeImageDigest: sha256Schema,
	preprocessing: z.literal('fixed-track-view-frames.v1'),
	precision: z.enum(['float32', 'float16', 'bfloat16']),
	confidenceCalibration: profileIdentifier,
	identityConfidenceThreshold: z.number().min(0).max(1),
	promptSemantics: z.literal('subject-box-center-positive-point.v1'),
	tracking: z.strictObject({
		minimumAreaRatio: z.number().positive(),
		maximumSeedAreaRatio: z.number().positive(),
		maximumFrameAreaRatio: z.number().positive(),
		maximumCenterDisplacement: z.number().positive().max(1),
	}),
});

export type InferenceProfile = z.infer<typeof inferenceProfileSchema>;

type CanonicalJson = string | { readonly [key: string]: CanonicalJson };

export const canonicalInferenceProfile = (
	profile: InferenceProfile,
): Uint8Array => {
	const parsed = inferenceProfileSchema.parse(profile);
	return new TextEncoder().encode(
		canonicalJson({
			canonicalizationVersion: parsed.canonicalizationVersion,
			confidenceCalibration: parsed.confidenceCalibration,
			contractVersion: parsed.contractVersion,
			identityConfidenceThreshold: float64Token(
				parsed.identityConfidenceThreshold,
			),
			model: parsed.model,
			pipeline: parsed.pipeline,
			precision: parsed.precision,
			preprocessing: parsed.preprocessing,
			promptSemantics: parsed.promptSemantics,
			provider: parsed.provider,
			runtimeImageDigest: parsed.runtimeImageDigest,
			tracking: {
				maximumCenterDisplacement: float64Token(
					parsed.tracking.maximumCenterDisplacement,
				),
				maximumFrameAreaRatio: float64Token(
					parsed.tracking.maximumFrameAreaRatio,
				),
				maximumSeedAreaRatio: float64Token(
					parsed.tracking.maximumSeedAreaRatio,
				),
				minimumAreaRatio: float64Token(parsed.tracking.minimumAreaRatio),
			},
		}),
	);
};

export const digestInferenceProfile = async (
	profile: InferenceProfile,
): Promise<string> => {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		canonicalInferenceProfile(profile),
	);
	return [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, '0'))
		.join('');
};

export const canonicalJson = (value: CanonicalJson): string => {
	if (typeof value === 'string') return JSON.stringify(value);
	return `{${Object.entries(value)
		.sort(([left], [right]) => (left < right ? -1 : 1))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
		.join(',')}}`;
};

export const float64Token = (value: number): string => {
	const buffer = new ArrayBuffer(8);
	new DataView(buffer).setFloat64(0, value === 0 ? 0 : value);
	return `f64:${[...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')}`;
};
