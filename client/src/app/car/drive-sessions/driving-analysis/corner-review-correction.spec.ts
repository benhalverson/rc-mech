import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalysisLifecycleGateway } from './analysis-lifecycle-gateway';
import { CornerReview } from './corner-review';
import { CornerReviewStore } from './corner-review-store';
import type { DrivingAnalysis } from './driving-analysis.models';
import { DrivingAnalysisRequestIdentityCapability } from './driving-analysis-request-identity';
import {
	RACE_RECORDING_PART_SIZE,
	type RaceRecording,
} from './race-recording.models';
import { ReidentificationStore } from './reidentification-store';

const analysis: DrivingAnalysis = {
	id: 'analysis-1',
	requestId: 'request-1',
	carId: 'car-1',
	driveSessionId: 'drive-1',
	raceVideoId: 'video-1',
	approvedTrackMapVersionId: 'map-1',
	raceWindow: { startTimestampMs: 0, endTimestampMs: 1000 },
	subjectSeed: {
		timestampMs: 0,
		frameIndex: 0,
		identity: 'subject',
		box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
	},
	sourceLayout: {
		version: 'fixed-track-view.v1',
		digest: 'a'.repeat(64),
		width: 320,
		height: 180,
		trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
	},
	lifecycle: 'awaiting-reidentification',
	status: 'awaiting-reidentification',
	stage: 'tracking',
	progress: 99,
	stateVersion: 3,
	createdAt: '2026-09-18T00:00:00.000Z',
	updatedAt: '2026-09-18T00:00:00.000Z',
};
const recording: RaceRecording = {
	id: 'video-1',
	carId: 'car-1',
	driveSessionId: 'drive-1',
	fileName: 'race.mp4',
	contentType: 'video/mp4',
	sizeBytes: 100,
	partSizeBytes: RACE_RECORDING_PART_SIZE,
	status: 'ready',
	uploadedBytes: 100,
	uploadedPartNumbers: [1],
	validationStateVersion: 1,
	media: {
		byteCount: 100,
		durationMs: 1000,
		width: 320,
		height: 180,
		videoCodec: 'h264',
		audioCodecs: [],
		containerFormats: ['mp4'],
		decodedFrameCount: 10,
		averageFrameRate: { numerator: 10, denominator: 1 },
		timeBase: { numerator: 1, denominator: 1000 },
		sampleAspectRatio: { numerator: 1, denominator: 1 },
		displayAspectRatio: { numerator: 16, denominator: 9 },
		startTimeMs: 0,
		checksumSha256: 'b'.repeat(64),
	},
	validationError: null,
	validatedAt: 'now',
	playbackUrl: '/api/v1/race-videos/video-1/content',
	createdAt: 'now',
	updatedAt: 'now',
	expiresAt: 'later',
	completedAt: 'now',
};

afterEach(() => {
	TestBed.inject(HttpTestingController).verify();
	TestBed.resetTestingModule();
});

it.each([
	'missing-analysis',
	'missing-recording',
	'ready',
	'already-running',
	'wrong-recording',
] as const)('reopens correction with %s context', async (scenario) => {
	TestBed.configureTestingModule({
		providers: [
			provideHttpClient(),
			provideHttpClientTesting(),
			provideRouter([]),
			CornerReviewStore,
			AnalysisLifecycleGateway,
			DrivingAnalysisRequestIdentityCapability,
			ReidentificationStore,
		],
	});
	const store = TestBed.inject(CornerReviewStore);
	expect(store.correction()).toBeNull();
	expect(store.correctionError()).toBeNull();
	const http = TestBed.inject(HttpTestingController);
	const fixture = TestBed.createComponent(CornerReview);
	fixture.componentRef.setInput('analysisId', 'analysis-1');
	fixture.detectChanges();
	TestBed.tick();
	http
		.expectOne('/api/v1/driving-analyses/analysis-1/clips')
		.flush({ clips: [] });
	http.expectOne('/api/v1/driving-analyses/analysis-1/lifecycle').flush({
		lifecycle: {
			analysisId: 'analysis-1',
			status: 'awaiting-reidentification',
			stateVersion: 3,
			permanent: false,
			canCancel: true,
			canRetry: false,
			failure: null,
		},
	});
	http.expectOne('/api/v1/driving-analyses/analysis-1/evidence').flush({
		evidence: {
			analysisId: 'analysis-1',
			carId: 'car-1',
			driveSessionId: 'drive-1',
			stateVersion: 3,
			status: 'awaiting-reidentification',
			runId: 'run-1',
			trackMapVersionId: 'map-1',
			tieToleranceMs: null,
			corners: [],
		},
	});
	TestBed.tick();
	const request = await vi.waitFor(() => {
		TestBed.tick();
		return http.expectOne('/api/v1/driving-analyses/analysis-1');
	});
	expect(request.request.withCredentials).toBe(true);
	if (scenario === 'missing-analysis') {
		request.flush({}, { status: 404, statusText: 'Not Found' });
	} else {
		request.flush({
			drivingAnalysis:
				scenario === 'already-running'
					? { ...analysis, lifecycle: 'tracking', status: 'running' }
					: analysis,
		});
		if (scenario === 'already-running') {
			await vi.waitFor(() =>
				expect(store.correctionAnalysisResource.hasValue()).toBe(true),
			);
			TestBed.tick();
			http.expectNone('/api/v1/race-videos/video-1');
			expect(store.correction()).toBeNull();
			return;
		}
		const source = await vi.waitFor(() => {
			TestBed.tick();
			return http.expectOne('/api/v1/race-videos/video-1');
		});
		expect(source.request.withCredentials).toBe(true);
		expect(store.correction()).toBeNull();
		if (scenario === 'missing-recording')
			source.flush({}, { status: 404, statusText: 'Not Found' });
		else
			source.flush({
				raceVideo:
					scenario === 'wrong-recording'
						? {
								...recording,
								id: 'video-2',
								playbackUrl: '/api/v1/race-videos/video-2/content',
							}
						: recording,
			});
	}
	TestBed.tick();
	if (scenario === 'ready') {
		await vi.waitFor(() =>
			expect(store.correction()).toEqual({ analysis, recording }),
		);
		expect(store.correctionError()).toBeNull();
		fixture.detectChanges();
		const context = await vi.waitFor(() => {
			TestBed.tick();
			return http.expectOne((request) =>
				request.url.endsWith('/reidentification'),
			);
		});
		context.flush({
			context: {
				runId: 'run-1',
				segmentId: 'segment-1',
				acceptedDigest: 'a'.repeat(64),
				gap: { startTimestampMs: 200, reason: 'missing' },
				frames: [{ frameIndex: 7, timestampMs: 700 }],
			},
		});
		await fixture.whenStable();
		fixture.detectChanges();
		expect(
			fixture.nativeElement.querySelector('app-subject-reidentification'),
		).not.toBeNull();
		store.selectAnalysis({ analysisId: '' });
		TestBed.tick();
		expect(store.correction()).toBeNull();
		return;
	}
	if (scenario === 'wrong-recording') {
		await vi.waitFor(() =>
			expect(store.correctionRecordingResource.hasValue()).toBe(true),
		);
		expect(store.correction()).toBeNull();
		return;
	}
	await vi.waitFor(() =>
		expect(store.correctionError()).toBe(
			'The recording and analysis needed for correction could not be loaded. Refresh evidence to try again.',
		),
	);
	fixture.detectChanges();
	expect(fixture.nativeElement.textContent).toContain(
		'needed for correction could not be loaded',
	);
});
