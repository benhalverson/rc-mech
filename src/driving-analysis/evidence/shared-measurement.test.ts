import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import fixture from '../../../containers/driving-analysis/tests/fixtures/subject-tracking/deterministic-measurement.json';
import {
	subjectObservationSegmentSchema,
	subjectSeedSchema,
} from '../tracking/contracts';
import { preparedFrameManifestSchema } from '../tracking/track-view-contracts';
import { CornerEvidenceError, measureAcceptedSegment } from './corner-evidence';

describe('shared Python observation measurement', () => {
	test.each(fixture.cases)('$name', (scenario) => {
		const manifest = preparedFrameManifestSchema.parse({
			...fixture.manifest,
			frames: fixture.manifest.frames.slice(0, scenario.frameCount),
		});
		const input = {
			window: manifest.window,
			averageFrameRate: manifest.averageFrameRate,
			manifest,
			seed: subjectSeedSchema.parse(fixture.seed),
			segment: subjectObservationSegmentSchema.parse(scenario.segment),
			corners: fixture.corners.map((corner) => ({
				...corner,
				entryGate: {
					...corner.entryGate,
					direction: z
						.enum(['forward', 'reverse'])
						.parse(corner.entryGate.direction),
				},
				exitGate: {
					...corner.exitGate,
					direction: z
						.enum(['forward', 'reverse'])
						.parse(corner.exitGate.direction),
				},
			})),
		};
		if (scenario.expectedError) {
			expect(() => measureAcceptedSegment(input)).toThrow(
				new CornerEvidenceError('INVALID_OBSERVATIONS'),
			);
		} else {
			expect(measureAcceptedSegment(input)).toEqual(scenario.expected);
		}
	});
});
