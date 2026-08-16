import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { RUN_ID } from '../../testing/driving-analysis-tracking-fixtures';
import {
	CORRELATION_ID,
	frameManifestFixture,
	PREPARED_MEDIA_ID,
	prepareAcceptedFixture,
} from '../../testing/prepared-track-view-fixtures';
import {
	preparedFrameManifestSchema,
	prepareStageRequestSchema,
	prepareStageResponseSchema,
} from './track-view-contracts';

const INPUT_DIGEST = '8'.repeat(64);

describe('Track-view preparation contracts', () => {
	test('matches the Python accepted-response fixture', () => {
		const fixture = JSON.parse(
			readFileSync(
				resolve(
					dirname(fileURLToPath(import.meta.url)),
					'../../../containers/driving-analysis/tests/fixtures/subject-tracking/prepare-accepted.json',
				),
				'utf8',
			),
		);
		expect(prepareStageResponseSchema.parse(fixture).outcome).toBe('accepted');
	});

	test('requires a strict bounded request and accepted response', () => {
		const request = {
			contractVersion: 'subject-tracking.v1',
			correlationId: CORRELATION_ID,
			caseId: RUN_ID,
			preparedMediaId: PREPARED_MEDIA_ID,
			input: { stagedMediaId: RUN_ID, expectedByteCount: 100 },
			window: { startTimestampMs: 100, endTimestampMs: 400 },
			pipelineVersion: 'subject-tracking.v1',
		};
		expect(prepareStageRequestSchema.parse(request)).toEqual(request);
		expect(
			prepareStageRequestSchema.safeParse({ ...request, browserObjectKey: 'x' })
				.success,
		).toBe(false);
		expect(
			prepareStageResponseSchema.parse(prepareAcceptedFixture(INPUT_DIGEST))
				.outcome,
		).toBe('accepted');
	});

	test.each([
		['INVALID_REQUEST', 'request', 'processing request rejected'],
		['MEDIA_UNAVAILABLE', 'prepare', 'processing media unavailable'],
		['PREPARATION_FAILED', 'prepare', 'Race window preparation failed safely'],
		['INFERENCE_UNAVAILABLE', 'initialize', 'inference provider unavailable'],
		['INFERENCE_FAILED', 'track', 'inference failed safely'],
		['RESOURCE_LIMIT', 'serialize', 'processing resource limit exceeded'],
		['ARTIFACT_CONFLICT', 'serialize', 'immutable artifact already exists'],
		['SERVICE_BUSY', 'admission', 'processing service is busy'],
	] as const)(
		'accepts the canonical %s safe error only',
		(code, stage, message) => {
			const response = {
				contractVersion: 'subject-tracking.v1',
				correlationId: null,
				outcome: 'rejected',
				caseId: null,
				error: { code, stage, message },
			};
			expect(prepareStageResponseSchema.parse(response)).toEqual(response);
			expect(
				prepareStageResponseSchema.safeParse({
					...response,
					error: { ...response.error, stage: 'track' },
				}).success,
			).toBe(stage === 'track');
		},
	);

	test.each(['prepare', 'track'] as const)(
		'accepts a canonical %s timeout',
		(stage) => {
			expect(
				prepareStageResponseSchema.safeParse({
					contractVersion: 'subject-tracking.v1',
					correlationId: CORRELATION_ID,
					outcome: 'rejected',
					caseId: RUN_ID,
					error: {
						code: 'PROCESS_TIMEOUT',
						stage,
						message: 'processing exceeded its time limit',
					},
				}).success,
			).toBe(true);
		},
	);

	test('rejects noncanonical timeout fields', () => {
		expect(
			prepareStageResponseSchema.safeParse({
				contractVersion: 'subject-tracking.v1',
				correlationId: null,
				outcome: 'rejected',
				caseId: null,
				error: {
					code: 'PROCESS_TIMEOUT',
					stage: 'request',
					message: 'processing exceeded its time limit',
				},
			}).success,
		).toBe(false);
	});
});

describe('prepared VFR frame manifest', () => {
	test('preserves exact ordered source frame indexes and timestamps', () => {
		const manifest = frameManifestFixture(INPUT_DIGEST);
		expect(preparedFrameManifestSchema.parse(manifest).frames).toEqual([
			{ preparedFrameIndex: 0, frameIndex: 2, timestampMs: 100 },
			{ preparedFrameIndex: 1, frameIndex: 4, timestampMs: 215 },
			{ preparedFrameIndex: 2, frameIndex: 7, timestampMs: 333 },
		]);
	});

	test.each([
		{ frames: [{ preparedFrameIndex: 1, frameIndex: 2, timestampMs: 100 }] },
		{
			frames: [
				{ preparedFrameIndex: 0, frameIndex: 2, timestampMs: 100 },
				{ preparedFrameIndex: 2, frameIndex: 4, timestampMs: 215 },
			],
		},
		{
			frames: [
				{ preparedFrameIndex: 0, frameIndex: 2, timestampMs: 100 },
				{ preparedFrameIndex: 1, frameIndex: 2, timestampMs: 215 },
			],
		},
		{
			frames: [
				{ preparedFrameIndex: 0, frameIndex: 2, timestampMs: 100 },
				{ preparedFrameIndex: 1, frameIndex: 4, timestampMs: 100 },
			],
		},
		{ frames: [{ preparedFrameIndex: 0, frameIndex: 2, timestampMs: 400 }] },
	] as const)('rejects a non-provenant frame sequence', ({ frames }) => {
		expect(
			preparedFrameManifestSchema.safeParse({
				...frameManifestFixture(INPUT_DIGEST),
				frames,
			}).success,
		).toBe(false);
	});
});
