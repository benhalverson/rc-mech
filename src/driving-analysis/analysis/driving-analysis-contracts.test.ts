import { describe, expect, test } from 'vitest';
import {
	createDrivingAnalysisInputSchema,
	digestDrivingAnalysisCommand,
	digestFixedTrackViewLayout,
	drivingAnalysisSourceLayoutDigestSchema,
	drivingAnalysisWorkflowPayloadSchema,
	MAX_RACE_WINDOW_DURATION_MS,
} from './driving-analysis-contracts';

const input = () => ({
	requestId: '55555555-5555-4555-8555-555555555555',
	raceVideoId: '33333333-3333-4333-8333-333333333333',
	approvedTrackMapVersionId: '44444444-4444-4444-8444-444444444444',
	raceWindow: { startTimestampMs: 100, endTimestampMs: 1000 },
	subjectSeed: {
		timestampMs: 200,
		frameIndex: 12,
		identity: 'subject-1',
		box: { x: 0.25, y: 0.4, width: 0.08, height: 0.06 },
	},
});

describe('Driving-analysis creation contracts', () => {
	test('accepts one strict bounded Race-window and Track-view seed command', () => {
		expect(createDrivingAnalysisInputSchema.parse(input())).toEqual(input());
		expect(
			drivingAnalysisWorkflowPayloadSchema.parse({
				kind: 'analysis-creation.v1',
				ownerId: 'owner-1',
				analysisId: '66666666-6666-4666-8666-666666666666',
				workflowId: '66666666-6666-4666-8666-666666666666',
				workflowSequence: 1,
				expectedStateVersion: 1,
			}),
		).toMatchObject({ ownerId: 'owner-1' });
		expect(drivingAnalysisSourceLayoutDigestSchema.parse('a'.repeat(64))).toBe(
			'a'.repeat(64),
		);
	});

	test.each([
		{
			...input(),
			raceWindow: {
				startTimestampMs: 100,
				endTimestampMs: 100 + MAX_RACE_WINDOW_DURATION_MS + 1,
			},
		},
		{
			...input(),
			subjectSeed: { ...input().subjectSeed, timestampMs: 99 },
		},
		{
			...input(),
			subjectSeed: { ...input().subjectSeed, timestampMs: 1000 },
		},
		{
			...input(),
			subjectSeed: {
				...input().subjectSeed,
				box: { ...input().subjectSeed.box, x: Number.NaN },
			},
		},
		{
			...input(),
			subjectSeed: {
				...input().subjectSeed,
				box: { ...input().subjectSeed.box, x: 0.99 },
			},
		},
		{ ...input(), extra: true },
	])('rejects malformed creation input %#', (candidate) => {
		expect(createDrivingAnalysisInputSchema.safeParse(candidate).success).toBe(
			false,
		);
	});

	test('digests every immutable request field and fixed source dimension', async () => {
		const command = {
			ownerId: 'owner-1',
			carId: 'car-1',
			driveSessionId: 'drive-1',
			input: createDrivingAnalysisInputSchema.parse(input()),
		};
		const digest = await digestDrivingAnalysisCommand(command);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		await expect(
			digestDrivingAnalysisCommand({
				...command,
				input: {
					...command.input,
					subjectSeed: {
						...command.input.subjectSeed,
						box: { ...command.input.subjectSeed.box, height: 0.07 },
					},
				},
			}),
		).resolves.not.toBe(digest);
		await expect(digestFixedTrackViewLayout(1920, 1080)).resolves.toMatch(
			/^[0-9a-f]{64}$/,
		);
		await expect(digestFixedTrackViewLayout(0, 1080)).rejects.toThrow();
	});
});
