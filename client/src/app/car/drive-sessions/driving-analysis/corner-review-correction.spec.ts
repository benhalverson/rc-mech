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
import { PrivateVideoPlayerCapability } from './private-video-player';
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

it.each(['refresh', 'navigate'] as const)(
	'handles lifecycle changes during initial loads before %s',
	async (scenario) => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				CornerReviewStore,
				AnalysisLifecycleGateway,
				DrivingAnalysisRequestIdentityCapability,
			],
		});
		const store = TestBed.inject(CornerReviewStore);
		const http = TestBed.inject(HttpTestingController);
		const lifecycleUrl = '/api/v1/driving-analyses/analysis-1/lifecycle';
		const evidenceUrl = '/api/v1/driving-analyses/analysis-1/evidence';
		const clipsUrl = '/api/v1/driving-analyses/analysis-1/clips';
		const analysisUrl = '/api/v1/driving-analyses/analysis-1';
		const lifecycle = (stateVersion: number) => ({
			analysisId: 'analysis-1',
			status: stateVersion === 1 ? 'running' : 'awaiting-reidentification',
			stateVersion,
			permanent: false,
			canCancel: true,
			canRetry: false,
			failure: null,
		});
		const evidence = (stateVersion: number) => ({
			analysisId: 'analysis-1',
			carId: 'car-1',
			driveSessionId: 'drive-1',
			stateVersion,
			status: stateVersion === 1 ? 'running' : 'awaiting-reidentification',
			runId: 'run-1',
			trackMapVersionId: 'map-1',
			tieToleranceMs: null,
			corners: [],
		});
		store.selectAnalysis({ analysisId: 'analysis-1' });
		TestBed.tick();
		const firstEvidence = http.expectOne(evidenceUrl);
		const firstClips = http.expectOne(clipsUrl);
		http.expectOne(lifecycleUrl).flush({ lifecycle: lifecycle(1) });
		const firstAnalysis = await vi.waitFor(() => {
			TestBed.tick();
			return http.expectOne(analysisUrl);
		});
		for (const stateVersion of [2, 3]) {
			store.lifecycleResource.reload();
			TestBed.tick();
			http
				.expectOne(lifecycleUrl)
				.flush({ lifecycle: lifecycle(stateVersion) });
			await vi.waitFor(() => {
				TestBed.tick();
				expect(store.lifecycle()?.stateVersion).toBe(stateVersion);
			});
		}
		http.expectNone(evidenceUrl);
		http.expectNone(clipsUrl);
		http.expectNone(analysisUrl);
		if (scenario === 'navigate') {
			store.selectAnalysis({ analysisId: 'analysis-2' });
			TestBed.tick();
			expect(firstEvidence.cancelled).toBe(true);
			expect(firstClips.cancelled).toBe(true);
			firstAnalysis.flush({ drivingAnalysis: analysis });
			TestBed.tick();
			expect(store.analysis()).toBeNull();
			expect(store.correction()).toBeNull();
			http.expectOne('/api/v1/driving-analyses/analysis-2/lifecycle').flush({
				lifecycle: { ...lifecycle(1), analysisId: 'analysis-2' },
			});
			http.expectOne('/api/v1/driving-analyses/analysis-2/evidence').flush({
				evidence: { ...evidence(1), analysisId: 'analysis-2' },
			});
			http
				.expectOne('/api/v1/driving-analyses/analysis-2/clips')
				.flush({ clips: [] });
			const nextAnalysis = await vi.waitFor(() => {
				TestBed.tick();
				return http.expectOne('/api/v1/driving-analyses/analysis-2');
			});
			nextAnalysis.flush({
				drivingAnalysis: {
					...analysis,
					id: 'analysis-2',
					stateVersion: 1,
					status: 'running',
					lifecycle: 'tracking',
				},
			});
			await vi.waitFor(() => {
				TestBed.tick();
				expect(store.analysis()?.id).toBe('analysis-2');
				expect(store.review()?.analysisId).toBe('analysis-2');
			});
			http.expectNone(() => true);
			return;
		}
		firstEvidence.flush({ evidence: evidence(1) });
		firstClips.flush({ clips: [] });
		firstAnalysis.flush({
			drivingAnalysis: {
				...analysis,
				stateVersion: 1,
				status: 'running',
				lifecycle: 'tracking',
			},
		});
		const refreshed = await vi.waitFor(() => {
			TestBed.tick();
			const requests = http.match(() => true);
			expect(requests.map((request) => request.request.url).sort()).toEqual(
				[analysisUrl, clipsUrl, evidenceUrl].sort(),
			);
			return requests;
		});
		for (const request of refreshed) {
			request.flush(
				request.request.url === analysisUrl
					? { drivingAnalysis: analysis }
					: request.request.url === clipsUrl
						? { clips: [] }
						: { evidence: evidence(3) },
			);
		}
		const source = await vi.waitFor(() => {
			TestBed.tick();
			return http.expectOne('/api/v1/race-videos/video-1');
		});
		source.flush({ raceVideo: recording });
		await vi.waitFor(() => {
			TestBed.tick();
			expect(store.correction()).toEqual({ analysis, recording });
			expect(store.review()?.stateVersion).toBe(3);
		});
		http.expectNone(() => true);
	},
);

it.each([
	'missing-analysis',
	'missing-recording',
	'ready',
	'failed-context',
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
			PrivateVideoPlayerCapability,
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
	if (scenario === 'ready' || scenario === 'failed-context') {
		await vi.waitFor(() =>
			expect(store.correction()).toEqual({ analysis, recording }),
		);
		expect(store.correctionError()).toBeNull();
		fixture.detectChanges();
		let context = await vi.waitFor(() => {
			TestBed.tick();
			return http.expectOne((request) =>
				request.url.endsWith('/reidentification'),
			);
		});
		if (scenario === 'failed-context') {
			context.flush({}, { status: 503, statusText: 'Unavailable' });
			await fixture.whenStable();
			fixture.detectChanges();
			const element: HTMLElement = fixture.nativeElement;
			const retry = Array.from(element.querySelectorAll('button')).find(
				(button) => button.textContent?.trim() === 'Retry gap context',
			);
			expect(retry).toBeDefined();
			retry?.click();
			context = await vi.waitFor(() => {
				TestBed.tick();
				return http.expectOne((request) =>
					request.url.endsWith('/reidentification'),
				);
			});
			expect(context.request.params.get('version')).toBe('3');
		}
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
