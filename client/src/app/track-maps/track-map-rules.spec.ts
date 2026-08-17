import { describe, expect, it } from 'vitest';
import type { TrackCorner } from './track-map.models';
import { validateTrackCorners } from './track-map-rules';

const corner = (overrides: Partial<TrackCorner> = {}): TrackCorner => ({
	key: 'turn-1',
	name: 'Turn 1',
	order: 1,
	entryGate: {
		start: { x: 0.1, y: 0.2 },
		end: { x: 0.2, y: 0.2 },
		direction: 'forward',
	},
	exitGate: {
		start: { x: 0.3, y: 0.4 },
		end: { x: 0.4, y: 0.4 },
		direction: 'forward',
	},
	cornerView: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
	...overrides,
});

describe('track-map rules', () => {
	it('accepts valid corners and reports duplicate identity and order', () => {
		expect(validateTrackCorners([corner()])).toEqual([]);
		expect(
			validateTrackCorners([corner(), corner({ name: 'Turn duplicate' })]),
		).toEqual([
			'Corner key “turn-1” is duplicated.',
			'Corner order 1 is duplicated.',
		]);
	});
	it('reports invalid gates, points, and views', () => {
		const value = corner({
			entryGate: {
				start: { x: -1, y: 2 },
				end: { x: 0.1, y: 0.2 },
				direction: 'forward',
			},
			exitGate: {
				start: { x: 0.3, y: 0.4 },
				end: { x: 0.3, y: 0.4 },
				direction: 'forward',
			},
			cornerView: { x: 0.8, y: 0.8, width: 0.4, height: 0 },
		});
		expect(validateTrackCorners([value])).toHaveLength(3);
	});
	it('requires a name and canonical stable key', () => {
		expect(
			validateTrackCorners([corner({ name: '', key: 'Bad key' })]),
		).toEqual([
			'Every Corner needs a name.',
			'Corner: stable key must use lowercase letters, numbers, and single hyphens.',
		]);
	});
	it('rejects nonfinite coordinates', () => {
		expect(
			validateTrackCorners([
				corner({
					entryGate: {
						...corner().entryGate,
						start: { x: Number.POSITIVE_INFINITY, y: Number.NaN },
					},
				}),
			]),
		).toEqual([
			'Turn 1: entry gate must have two distinct points inside the Track view.',
		]);
	});
});
