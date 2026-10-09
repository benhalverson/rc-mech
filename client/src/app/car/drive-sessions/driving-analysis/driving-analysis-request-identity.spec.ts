import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { StartDrivingAnalysisCommand } from './driving-analysis.models';
import { DrivingAnalysisRequestIdentityCapability } from './driving-analysis-request-identity';

const command = (): StartDrivingAnalysisCommand => ({
	carId: 'car-1',
	driveSessionId: 'drive-1',
	raceVideoId: 'video-1',
	approvedTrackMapVersionId: 'map-1',
	raceWindow: { startTimestampMs: 0, endTimestampMs: 1000 },
	subjectSeed: {
		timestampMs: 100,
		frameIndex: 3,
		identity: 'subject-1',
		box: { x: 0.1, y: 0.2, width: 0.1, height: 0.1 },
	},
});

describe('DrivingAnalysisRequestIdentityCapability', () => {
	it('keeps exact retries stable across component remounts and rotates changed commands', () => {
		TestBed.configureTestingModule({
			providers: [DrivingAnalysisRequestIdentityCapability],
		});
		const capability = TestBed.inject(DrivingAnalysisRequestIdentityCapability);
		const first = capability.requestId(command());
		expect(capability.requestId(command())).toBe(first);
		expect(
			capability.requestId({
				...command(),
				raceWindow: { startTimestampMs: 0, endTimestampMs: 2000 },
			}),
		).not.toBe(first);
		capability.clear();
		expect(capability.requestId(command())).not.toBe(first);
		TestBed.resetTestingModule();
	});
});
