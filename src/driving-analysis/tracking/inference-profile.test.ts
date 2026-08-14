import { describe, expect, test } from 'vitest';
import {
	inferenceProfileFixture,
	PROFILE_DIGEST,
} from '../../testing/driving-analysis-tracking-fixtures';
import {
	canonicalInferenceProfile,
	digestInferenceProfile,
	inferenceProfileSchema,
} from './inference-profile';

const EXPECTED_CANONICAL_PROFILE =
	'{"canonicalizationVersion":"inference-profile-c14n.v1",' +
	'"confidenceCalibration":"sam31-point-mask-v1",' +
	'"contractVersion":"inference-profile.v1",' +
	'"identityConfidenceThreshold":"f64:3fd3333333333333",' +
	'"model":{"digest":"1111111111111111111111111111111111111111111111111111111111111111",' +
	'"name":"sam3.1","version":"96914d2425f90a64f45ca977c2b5165418099543"},' +
	'"pipeline":{"digest":"2222222222222222222222222222222222222222222222222222222222222222",' +
	'"version":"subject-tracking.v1"},"precision":"float32",' +
	'"preprocessing":"fixed-track-view-frames.v1",' +
	'"promptSemantics":"subject-box-center-positive-point.v1",' +
	'"provider":"local-sam31",' +
	'"runtimeImageDigest":"3333333333333333333333333333333333333333333333333333333333333333",' +
	'"tracking":{"maximumCenterDisplacement":"f64:3fd6666666666666",' +
	'"maximumFrameAreaRatio":"f64:4020000000000000",' +
	'"maximumSeedAreaRatio":"f64:4039000000000000",' +
	'"minimumAreaRatio":"f64:3fa999999999999a"}}';

describe('Inference profile canonicalization', () => {
	test('matches the Python canonical bytes and digest exactly', async () => {
		const profile = inferenceProfileFixture();

		expect(new TextDecoder().decode(canonicalInferenceProfile(profile))).toBe(
			EXPECTED_CANONICAL_PROFILE,
		);
		expect(await digestInferenceProfile(profile)).toBe(PROFILE_DIGEST);
	});

	test('normalizes negative zero without changing semantic identity', async () => {
		const positive = {
			...inferenceProfileFixture(),
			identityConfidenceThreshold: 0,
		};
		const negative = {
			...positive,
			identityConfidenceThreshold: -0,
		};

		expect(await digestInferenceProfile(negative)).toBe(
			await digestInferenceProfile(positive),
		);
	});

	test('rejects noncanonical or unknown profile values', () => {
		expect(
			inferenceProfileSchema.safeParse({
				...inferenceProfileFixture(),
				precision: 'tf32',
			}).success,
		).toBe(false);
		expect(
			inferenceProfileSchema.safeParse({
				...inferenceProfileFixture(),
				hostname: 'gpu.chassisnotes.com',
			}).success,
		).toBe(false);
		expect(
			inferenceProfileSchema.safeParse({
				...inferenceProfileFixture(),
				tracking: {
					...inferenceProfileFixture().tracking,
					maximumCenterDisplacement: 0,
				},
			}).success,
		).toBe(false);
	});
});
