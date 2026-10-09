import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import observationsCompleteAcceptedFixture from '../../../containers/driving-analysis/tests/fixtures/subject-tracking/observations-complete-accepted.json';
import prepareAcceptedFixture from '../../../containers/driving-analysis/tests/fixtures/subject-tracking/prepare-accepted.json';
import trackGapAcceptedFixture from '../../../containers/driving-analysis/tests/fixtures/subject-tracking/track-gap-accepted.json';
import {
	cancelFixture,
	executionIdentityFixture,
	jobStatusFixture,
	submissionFixture,
	transferGrantFixture,
} from '../../testing/driving-analysis-tracking-fixtures';
import {
	cancelCommandSchema,
	executionIdentitySchema,
	jobStatusSchema,
	MAX_SUBJECT_OBSERVATIONS,
	observationSegmentArtifactSchema,
	outputArtifactSchema,
	preparedMediaArtifactSchema,
	rejectedJobResponseSchema,
	safeJobErrorSchema,
	subjectObservationSegmentSchema,
	trackingJobSubmissionSchema,
	transferGrantCommandSchema,
	transferRequestSchema,
} from './contracts';

describe('tracking provider contracts', () => {
	test('shares the provider runtime observation ceiling', () => {
		const segmentSchema = z.toJSONSchema(subjectObservationSegmentSchema);
		const artifactSchema = z.toJSONSchema(observationSegmentArtifactSchema);
		expect(segmentSchema.properties?.observations).toMatchObject({
			maxItems: MAX_SUBJECT_OBSERVATIONS,
		});
		expect(artifactSchema.properties?.observationCount).toMatchObject({
			maximum: MAX_SUBJECT_OBSERVATIONS,
		});
	});

	test('accepts the strict shared provider payloads', () => {
		expect(
			subjectObservationSegmentSchema.parse(
				observationsCompleteAcceptedFixture,
			),
		).toEqual(observationsCompleteAcceptedFixture);
		expect(
			preparedMediaArtifactSchema.parse(prepareAcceptedFixture.prepared),
		).toEqual(prepareAcceptedFixture.prepared);
		expect(
			observationSegmentArtifactSchema.parse(trackGapAcceptedFixture.segment),
		).toEqual(trackGapAcceptedFixture.segment);
		expect(trackingJobSubmissionSchema.parse(submissionFixture())).toEqual(
			submissionFixture(),
		);
		expect(executionIdentitySchema.parse(executionIdentityFixture())).toEqual(
			executionIdentityFixture(),
		);
		expect(cancelCommandSchema.parse(cancelFixture())).toEqual(cancelFixture());
		expect(transferGrantCommandSchema.parse(transferGrantFixture())).toEqual(
			transferGrantFixture(),
		);
		expect(jobStatusSchema.parse(jobStatusFixture())).toEqual(
			jobStatusFixture(),
		);
		expect(jobStatusSchema.parse(jobStatusFixture(true))).toEqual(
			jobStatusFixture(true),
		);
		expect(outputArtifactSchema.parse(jobStatusFixture(true).artifact)).toEqual(
			jobStatusFixture(true).artifact,
		);
	});

	test('applies nullable status defaults without accepting unknown fields', () => {
		const {
			artifact: _artifact,
			error: _error,
			transferRequest: _transfer,
			...base
		} = jobStatusFixture();
		expect(jobStatusSchema.parse(base)).toMatchObject({
			artifact: null,
			error: null,
			transferRequest: null,
		});
		expect(
			jobStatusSchema.safeParse({
				...jobStatusFixture(),
				providerUrl: 'secret',
			}).success,
		).toBe(false);
	});

	test.each([
		{ field: 'caseId', value: 'bad/value' },
		{ field: 'caseId', value: 'bad\\value' },
		{ field: 'caseId', value: 'https://example.com' },
		{ field: 'caseId', value: 'bad\u0000value' },
	])('rejects unsafe identifiers: $value', ({ field, value }) => {
		const submission = submissionFixture();
		submission.trackingRequest = {
			...submission.trackingRequest,
			[field]: value,
		};
		expect(trackingJobSubmissionSchema.safeParse(submission).success).toBe(
			false,
		);
	});

	test.each([
		{ startTimestampMs: 400, endTimestampMs: 400 },
		{ startTimestampMs: 401, endTimestampMs: 400 },
	])('rejects unordered Race windows', (window) => {
		const submission = submissionFixture();
		submission.trackingRequest.prepared.window = window;
		expect(trackingJobSubmissionSchema.safeParse(submission).success).toBe(
			false,
		);
	});

	test.each([
		{ x: 0.1, y: 1 / 3, width: 1, height: 2 / 3 },
		{ x: 0, y: 0.2, width: 1, height: 2 / 3 },
		{ x: 0, y: 1 / 3, width: 0.9, height: 2 / 3 },
		{ x: 0, y: 1 / 3, width: 1, height: 0.5 },
	])('rejects a noncanonical fixed Track view', (trackView) => {
		const submission = submissionFixture();
		submission.trackingRequest.prepared.trackView = trackView;
		expect(trackingJobSubmissionSchema.safeParse(submission).success).toBe(
			false,
		);
	});

	test.each([
		{ x: 0.9, y: 0.2, width: 0.2, height: 0.2 },
		{ x: 0.1, y: 0.9, width: 0.2, height: 0.2 },
		{ x: 0.1, y: 0.2, width: 1e-7, height: 1e-7 },
	])('rejects a Subject box outside normalized bounds', (box) => {
		const submission = submissionFixture();
		submission.trackingRequest.subjectSeed.box = box;
		expect(trackingJobSubmissionSchema.safeParse(submission).success).toBe(
			false,
		);
	});

	test('binds the request case, seed window, and segment identity', () => {
		const wrongCase = submissionFixture();
		wrongCase.trackingRequest.caseId = 'other-case';
		expect(trackingJobSubmissionSchema.safeParse(wrongCase).success).toBe(
			false,
		);

		for (const timestampMs of [99, 400]) {
			const wrongSeed = submissionFixture();
			wrongSeed.trackingRequest.subjectSeed.timestampMs = timestampMs;
			expect(trackingJobSubmissionSchema.safeParse(wrongSeed).success).toBe(
				false,
			);
		}

		const wrongSegment = submissionFixture();
		wrongSegment.segmentId = '88888888-8888-4888-8888-888888888888';
		expect(trackingJobSubmissionSchema.safeParse(wrongSegment).success).toBe(
			false,
		);
	});

	test('binds Transfer methods to roles and HTTPS capabilities', () => {
		expect(
			transferRequestSchema.safeParse({
				transferRequestId: transferGrantFixture().transferRequestId,
				role: 'observation-artifact',
				method: 'PUT',
			}).success,
		).toBe(true);
		expect(
			transferRequestSchema.safeParse({
				transferRequestId: transferGrantFixture().transferRequestId,
				role: 'prepared-media',
				method: 'PUT',
			}).success,
		).toBe(false);
		for (const url of [
			'http://r2.example/object',
			'https://user@r2.example/object',
			'https://user:password@r2.example/object',
			'https://r2.example/object#fragment',
		]) {
			expect(
				transferGrantCommandSchema.safeParse({
					...transferGrantFixture(),
					url,
				}).success,
			).toBe(false);
		}
		expect(
			transferGrantCommandSchema.safeParse({
				...transferGrantFixture(),
				method: 'PUT',
			}).success,
		).toBe(false);
	});

	test('binds artifact completion to its gap', () => {
		const segment = jobStatusFixture(true).artifact?.segment;
		expect(segment).not.toBeNull();
		expect(
			observationSegmentArtifactSchema.safeParse({
				...segment,
				completed: false,
				gap: { startTimestampMs: 300, reason: 'ambiguous-identity' },
			}).success,
		).toBe(true);
		expect(
			observationSegmentArtifactSchema.safeParse({
				...segment,
				gap: { startTimestampMs: 300, reason: 'missing' },
			}).success,
		).toBe(false);
		expect(
			observationSegmentArtifactSchema.safeParse({
				...segment,
				completed: false,
				gap: null,
			}).success,
		).toBe(false);
	});

	test('validates the strict accepted observation bytes', () => {
		const provenance = jobStatusFixture(true).artifact?.segment.provenance;
		expect(provenance).toBeDefined();
		const first = {
			timestampMs: 100,
			frameIndex: 1,
			box: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
			center: { x: 0.2, y: 0.3 },
			visibility: 'visible',
			identityConfidence: 0.9,
			origin: 'detected',
			provenance,
		};
		const segment = {
			contractVersion: 'subject-observation-segment.v1',
			outcome: 'accepted',
			caseId: 'fixture-race',
			observations: [
				first,
				{
					...first,
					timestampMs: 200,
					frameIndex: 2,
				},
			],
			openGap: null,
			provenance,
		};
		expect(subjectObservationSegmentSchema.safeParse(segment).success).toBe(
			true,
		);
		for (const invalid of [
			{
				...segment,
				unknown: true,
			},
			{
				...segment,
				observations: [{ ...first, center: { x: 0.4, y: 0.3 } }],
			},
			{
				...segment,
				observations: [first, { ...first, timestampMs: 200 }],
			},
			{
				...segment,
				openGap: { startTimestampMs: 100, reason: 'missing' },
			},
			{
				...segment,
				observations: [
					{
						...first,
						provenance: { ...provenance, modelVersion: 'other' },
					},
				],
			},
		])
			expect(subjectObservationSegmentSchema.safeParse(invalid).success).toBe(
				false,
			);
	});

	test('requires canonical safe provider errors', () => {
		const error = {
			code: 'GPU_CAPACITY_BUSY',
			message: 'GPU execution capacity is busy',
		} as const;
		expect(safeJobErrorSchema.parse(error)).toEqual(error);
		expect(
			safeJobErrorSchema.safeParse({
				...error,
				message: 'Tracking job was not found',
			}).success,
		).toBe(false);
		expect(
			rejectedJobResponseSchema.parse({
				contractVersion: 'tracking-provider.v1',
				outcome: 'rejected',
				error,
			}),
		).toMatchObject({ outcome: 'rejected', error });
	});
});
