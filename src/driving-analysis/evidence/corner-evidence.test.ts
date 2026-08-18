import { describe, expect, test } from 'vitest';
import type { SubjectProvenance } from '../tracking/contracts';
import {
	assertCornerEvidenceBudget,
	CornerEvidenceError,
	MAX_CORNER_EVIDENCE_FRAMES,
	MAX_CORNER_EVIDENCE_OPERATIONS,
	MAX_CORNER_EVIDENCE_PASSES,
	measureAcceptedSegment,
} from './corner-evidence';

const provenance: SubjectProvenance = {
	provider: 'sam31',
	model: 'sam3.1',
	modelVersion: '1',
	pipelineVersion: 'subject-tracking.v1',
	configurationDigest: '1'.repeat(64),
	modelDigest: '2'.repeat(64),
	identityConfidenceThreshold: 0.9,
	confidenceCalibration: 'sam31-binary-v1',
};

const observation = (timestampMs: number, frameIndex: number, x: number) => ({
	timestampMs,
	frameIndex,
	box: { x: x - 0.05, y: 0.45, width: 0.1, height: 0.1 },
	center: { x, y: 0.5 },
	visibility: 'visible' as const,
	identityConfidence: 0.99,
	origin: 'detected' as const,
	provenance,
});

const input = () => ({
	window: { startTimestampMs: 0, endTimestampMs: 400 },
	averageFrameRate: { numerator: 10, denominator: 1 },
	manifest: {
		contractVersion: 'subject-tracking.v1' as const,
		preparedMediaId: '11111111-1111-4111-8111-111111111111',
		caseId: 'fixture-run',
		sourceChecksumSha256: '3'.repeat(64),
		sourceByteCount: 100,
		window: { startTimestampMs: 0, endTimestampMs: 400 },
		trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
		mediaByteCount: 50,
		mediaChecksumSha256: '4'.repeat(64),
		width: 160,
		height: 60,
		averageFrameRate: { numerator: 10, denominator: 1 },
		ffmpegVersion: '7.1.2',
		pipelineVersion: 'subject-tracking.v1' as const,
		preparationInputDigest: '5'.repeat(64),
		preparationConfigurationDigest: '6'.repeat(64),
		frames: [
			{ preparedFrameIndex: 0, frameIndex: 1, timestampMs: 100 },
			{ preparedFrameIndex: 1, frameIndex: 2, timestampMs: 200 },
			{ preparedFrameIndex: 2, frameIndex: 3, timestampMs: 300 },
		],
	},
	seed: {
		timestampMs: 100,
		frameIndex: 1,
		identity: 'subject-car',
		box: { x: 0.15, y: 0.45, width: 0.1, height: 0.1 },
	},
	segment: {
		contractVersion: 'subject-observation-segment.v1' as const,
		outcome: 'accepted' as const,
		caseId: 'fixture-run',
		observations: [
			observation(100, 1, 0.2),
			observation(200, 2, 0.6),
			observation(300, 3, 0.9),
		],
		openGap: null,
		provenance,
	},
	corners: [
		{
			id: 'corner-1',
			key: 'turn-one',
			order: 1,
			entryGate: {
				start: { x: 0.4, y: 1 },
				end: { x: 0.4, y: 0 },
				direction: 'forward' as const,
			},
			exitGate: {
				start: { x: 0.75, y: 1 },
				end: { x: 0.75, y: 0 },
				direction: 'forward' as const,
			},
		},
	],
});

describe('deterministic corner evidence', () => {
	test('bounds frames and corner-frame work before measurement', () => {
		expect(() => assertCornerEvidenceBudget(3, 1)).not.toThrow();
		expect(() =>
			assertCornerEvidenceBudget(MAX_CORNER_EVIDENCE_FRAMES, 100),
		).not.toThrow();
		for (const [frames, corners] of [
			[0, 1],
			[MAX_CORNER_EVIDENCE_FRAMES + 1, 1],
			[1, 0],
			[
				MAX_CORNER_EVIDENCE_FRAMES,
				Math.floor(
					MAX_CORNER_EVIDENCE_OPERATIONS / MAX_CORNER_EVIDENCE_FRAMES,
				) + 1,
			],
			[1.5, 1],
		] as const)
			expect(() => assertCornerEvidenceBudget(frames, corners)).toThrow(
				new CornerEvidenceError('INVALID_OBSERVATIONS'),
			);
	});

	test('stops adversarial gate oscillation at the pass-emission budget', () => {
		const value = input();
		const frameCount = MAX_CORNER_EVIDENCE_PASSES * 2 + 3;
		value.window.endTimestampMs = frameCount + 1;
		value.manifest.window.endTimestampMs = frameCount + 1;
		value.manifest.frames = Array.from({ length: frameCount }, (_, index) => ({
			preparedFrameIndex: index,
			frameIndex: index + 1,
			timestampMs: index + 1,
		}));
		value.seed.timestampMs = 1;
		value.segment.observations = Array.from(
			{ length: frameCount },
			(_, index) =>
				observation(index + 1, index + 1, index % 2 === 0 ? 0.2 : 0.8),
		);
		const corner = value.corners[0];
		if (!corner) throw new Error('missing corner fixture');
		Object.assign(corner.exitGate, corner.entryGate);
		expect(() => measureAcceptedSegment(value)).toThrow(
			new CornerEvidenceError('INVALID_OBSERVATIONS'),
		);
	});

	test('interpolates finite directed gate crossings into one ranked pass', () => {
		expect(measureAcceptedSegment(input())).toEqual({
			version: 'corner-evidence.v1',
			passes: [
				{
					cornerId: 'corner-1',
					cornerKey: 'turn-one',
					cornerOrder: 1,
					ordinal: 1,
					entry: {
						timestampMs: 150,
						beforeFrameIndex: 1,
						afterFrameIndex: 2,
					},
					exit: {
						timestampMs: 250,
						beforeFrameIndex: 2,
						afterFrameIndex: 3,
					},
					durationMs: 100,
					eligibility: 'eligible',
					exclusionReason: null,
					rank: 1,
					tieGroup: 1,
					best: true,
				},
			],
		});
	});

	test('rejects observations that skip prepared frames', () => {
		const value = input();
		value.segment.observations.splice(1, 1);
		expect(() => measureAcceptedSegment(value)).toThrow(
			new CornerEvidenceError('INVALID_OBSERVATIONS'),
		);
	});

	test('ends an open traversal at a Tracking gap without interpolating identity', () => {
		const value = input();
		value.segment.observations.pop();
		value.segment.openGap = {
			startTimestampMs: 300,
			reason: 'ambiguous-identity',
		};
		expect(measureAcceptedSegment(value).passes).toEqual([
			{
				cornerId: 'corner-1',
				cornerKey: 'turn-one',
				cornerOrder: 1,
				ordinal: 1,
				entry: {
					timestampMs: 150,
					beforeFrameIndex: 1,
					afterFrameIndex: 2,
				},
				exit: null,
				durationMs: null,
				eligibility: 'ineligible',
				exclusionReason: 'tracking-gap',
				rank: null,
				tieGroup: null,
				best: false,
			},
		]);
	});

	test.each([
		{ visibility: 'uncertain' as const, identityConfidence: 0.99 },
		{ visibility: 'visible' as const, identityConfidence: 0.89 },
	])(
		'rejects untrusted accepted observations: $visibility at $identityConfidence',
		({ visibility, identityConfidence }) => {
			const value = input();
			Object.assign(value.segment.observations[1] as object, {
				visibility,
				identityConfidence,
			});
			expect(() => measureAcceptedSegment(value)).toThrow(
				new CornerEvidenceError('INVALID_OBSERVATIONS'),
			);
		},
	);

	test('honors the reverse direction of a directed gate', () => {
		const value = input();
		value.segment.observations.splice(
			0,
			3,
			observation(100, 1, 0.9),
			observation(200, 2, 0.6),
			observation(300, 3, 0.2),
		);
		const corner = value.corners[0];
		if (!corner) throw new Error('missing corner fixture');
		corner.entryGate.start.x = 0.75;
		corner.entryGate.end.x = 0.75;
		Object.assign(corner.entryGate, { direction: 'reverse' as const });
		corner.exitGate.start.x = 0.4;
		corner.exitGate.end.x = 0.4;
		Object.assign(corner.exitGate, { direction: 'reverse' as const });
		expect(measureAcceptedSegment(value).passes[0]).toMatchObject({
			entry: { timestampMs: 150 },
			exit: { timestampMs: 250 },
			durationMs: 100,
			eligibility: 'eligible',
		});
	});

	test('ties durations within one source frame and ranks later groups densely', () => {
		const value = input();
		const samples = [
			[100, 0.2],
			[200, 0.6],
			[300, 0.9],
			[400, 0.2],
			[500, 0.6],
			[600, 0.9],
			[700, 0.2],
			[800, 0.6],
			[1200, 0.9],
		] as const;
		value.window.endTimestampMs = 1300;
		value.manifest.window.endTimestampMs = 1300;
		value.segment.observations.splice(
			0,
			value.segment.observations.length,
			...samples.map(([timestampMs, x], index) =>
				observation(timestampMs, index + 1, x),
			),
		);
		value.manifest.frames.splice(
			0,
			value.manifest.frames.length,
			...samples.map(([timestampMs], index) => ({
				preparedFrameIndex: index,
				frameIndex: index + 1,
				timestampMs,
			})),
		);
		expect(
			measureAcceptedSegment(value).passes.map((pass) => ({
				durationMs: pass.durationMs,
				rank: pass.rank,
				tieGroup: pass.tieGroup,
				best: pass.best,
			})),
		).toEqual([
			{ durationMs: 100, rank: 1, tieGroup: 1, best: true },
			{ durationMs: 100, rank: 1, tieGroup: 1, best: true },
			{ durationMs: 250, rank: 2, tieGroup: 2, best: false },
		]);
	});

	test('marks repeated entry and stray exit crossings ineligible', () => {
		const repeated = input();
		const repeatedSamples = [
			[100, 0.2],
			[200, 0.6],
			[300, 0.2],
			[400, 0.6],
			[500, 0.9],
		] as const;
		repeated.window.endTimestampMs = 600;
		repeated.manifest.window.endTimestampMs = 600;
		repeated.segment.observations.splice(
			0,
			repeated.segment.observations.length,
			...repeatedSamples.map(([timestampMs, x], index) =>
				observation(timestampMs, index + 1, x),
			),
		);
		repeated.manifest.frames.splice(
			0,
			repeated.manifest.frames.length,
			...repeatedSamples.map(([timestampMs], index) => ({
				preparedFrameIndex: index,
				frameIndex: index + 1,
				timestampMs,
			})),
		);
		expect(
			measureAcceptedSegment(repeated).passes.map((pass) => ({
				entry: pass.entry?.timestampMs ?? null,
				exit: pass.exit?.timestampMs ?? null,
				eligibility: pass.eligibility,
				exclusionReason: pass.exclusionReason,
			})),
		).toEqual([
			{
				entry: 150,
				exit: null,
				eligibility: 'ineligible',
				exclusionReason: 'gate-order',
			},
			{
				entry: 350,
				exit: 450,
				eligibility: 'eligible',
				exclusionReason: null,
			},
		]);

		const stray = input();
		stray.segment.observations.splice(
			0,
			3,
			observation(100, 1, 0.6),
			observation(200, 2, 0.9),
			observation(300, 3, 0.95),
		);
		expect(measureAcceptedSegment(stray).passes).toEqual([
			expect.objectContaining({
				entry: null,
				exit: expect.objectContaining({ timestampMs: 150 }),
				eligibility: 'ineligible',
				exclusionReason: 'gate-order',
			}),
		]);
	});

	test('ends an open traversal at the Race window and rejects invalid timing inputs', () => {
		const open = input();
		const corner = open.corners[0];
		if (!corner) throw new Error('missing corner fixture');
		Object.assign(corner.exitGate, {
			start: { x: 0.95, y: 1 },
			end: { x: 0.95, y: 0 },
		});
		expect(measureAcceptedSegment(open).passes).toEqual([
			expect.objectContaining({
				entry: expect.objectContaining({ timestampMs: 150 }),
				exit: null,
				eligibility: 'ineligible',
				exclusionReason: 'race-window',
			}),
		]);

		const invalidRate = input();
		invalidRate.averageFrameRate.numerator = 0;
		expect(() => measureAcceptedSegment(invalidRate)).toThrow(
			new CornerEvidenceError('INVALID_OBSERVATIONS'),
		);
	});

	test('requires finite gate segments and exact manifest authority', () => {
		const finite = input();
		const corner = finite.corners[0];
		if (!corner) throw new Error('missing corner fixture');
		Object.assign(corner.entryGate, {
			start: { x: 0.4, y: 1 },
			end: { x: 0.4, y: 0.9 },
		});
		expect(measureAcceptedSegment(finite).passes).toEqual([
			expect.objectContaining({
				entry: null,
				eligibility: 'ineligible',
				exclusionReason: 'gate-order',
			}),
		]);

		const coincident = input();
		const coincidentCorner = coincident.corners[0];
		if (!coincidentCorner) throw new Error('missing corner fixture');
		Object.assign(coincidentCorner.exitGate, coincidentCorner.entryGate);
		expect(measureAcceptedSegment(coincident).passes).toEqual([
			expect.objectContaining({
				entry: expect.objectContaining({ timestampMs: 150 }),
				exit: expect.objectContaining({ timestampMs: 150 }),
				durationMs: 0,
				eligibility: 'eligible',
			}),
		]);

		for (const invalid of [
			() => {
				const value = input();
				value.seed.frameIndex = 99;
				return value;
			},
			() => {
				const value = input();
				value.segment.caseId = 'other-case';
				return value;
			},
			() => {
				const value = input();
				value.segment.observations.pop();
				return value;
			},
			() => {
				const value = input();
				value.segment.observations.pop();
				value.segment.openGap = {
					startTimestampMs: 299,
					reason: 'ambiguous-identity',
				};
				return value;
			},
		])
			expect(() => measureAcceptedSegment(invalid())).toThrow(
				new CornerEvidenceError('INVALID_OBSERVATIONS'),
			);
	});
});
