import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CornerReview } from './corner-review';
import {
	cornerReviewResponseSchema,
	type CornerReview as Review,
} from './corner-review.models';
import { CornerReviewGateway } from './corner-review-gateway';
import { CornerReviewStore } from './corner-review-store';

const evidence: Review = {
	analysisId: 'analysis-1',
	carId: 'car-1',
	driveSessionId: 'drive-1',
	stateVersion: 1,
	status: 'running',
	runId: 'run-1',
	trackMapVersionId: 'map-1',
	tieToleranceMs: 40,
	corners: [
		{
			id: 'corner-1',
			name: 'Hairpin',
			order: 0,
			passes: [
				{
					cornerId: 'corner-1',
					cornerKey: 'hairpin',
					cornerOrder: 0,
					ordinal: 1,
					entry: {
						timestampMs: 100.125,
						beforeFrameIndex: 2,
						afterFrameIndex: 3,
					},
					exit: {
						timestampMs: 600.875,
						beforeFrameIndex: 15,
						afterFrameIndex: 16,
					},
					durationMs: 500.75,
					eligibility: 'eligible',
					exclusionReason: null,
					rank: 1,
					tieGroup: 1,
					best: true,
					provenance: {
						segmentId: 'segment-1',
						segmentSequence: 0,
						profileDigest: 'a'.repeat(64),
						observationChecksum: 'b'.repeat(64),
						manifestChecksum: 'c'.repeat(64),
						measurementVersion: 'corner-evidence.v1',
						measurementDigest: 'd'.repeat(64),
					},
				},
			],
		},
	],
};

describe('Corner review', () => {
	let http: HttpTestingController;
	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter([]),
				CornerReviewGateway,
				CornerReviewStore,
			],
		});
		http = TestBed.inject(HttpTestingController);
	});
	afterEach(() => {
		try {
			http.verify();
		} finally {
			TestBed.resetTestingModule();
		}
	});
	const open = (analysisId: string, clips: object = { clips: [] }) => {
		const fixture = TestBed.createComponent(CornerReview);
		fixture.componentRef.setInput('analysisId', analysisId);
		fixture.detectChanges();
		TestBed.tick();
		for (const request of http.match((request) =>
			request.url.endsWith('/lifecycle'),
		))
			request.flush({
				lifecycle: {
					analysisId,
					status: 'cancelled',
					stateVersion: 1,
					permanent: false,
					canCancel: false,
					canRetry: false,
					failure: null,
				},
			});
		if (analysisId)
			http
				.expectOne(`/api/v1/driving-analyses/${analysisId}/clips`)
				.flush(clips);
		return {
			fixture,
			routeNativeElement: fixture.nativeElement as HTMLElement,
			detectChanges: () => fixture.detectChanges(),
		};
	};

	it('reviews accepted timing, exclusions, empty corners, and refreshed evidence', async () => {
		const harness = open('analysis-1', {
			clips: [
				{
					id: 'clip-1',
					cornerId: 'corner-1',
					ordinal: 1,
					segmentId: 'segment-1',
					status: 'ready',
					inputDigest: 'a'.repeat(64),
					checksum: 'b'.repeat(64),
					durationMs: 1500,
					pipelineVersion: 'corner-render.v1',
				},
			],
		});
		expect(harness.routeNativeElement?.textContent).toContain(
			'Loading accepted',
		);
		const request = http.expectOne(
			'/api/v1/driving-analyses/analysis-1/evidence',
		);
		expect(request.request.withCredentials).toBe(true);
		request.flush({ evidence });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const root = harness.routeNativeElement;
		expect(root?.textContent).toContain('500.75 ms');
		expect(root?.textContent).toContain('Best corner pass');
		expect(root.querySelector('video')?.getAttribute('src')).toBe(
			'/api/v1/driving-analyses/analysis-1/clips/clip-1/content',
		);
		expect(root?.textContent).toContain('between frames 2 and 3');
		expect(root?.textContent).toContain('40 ms');
		expect(root?.querySelector('a')?.getAttribute('href')).toBe(
			'/garage/car-1/drive-sessions',
		);
		root?.querySelector('button')?.click();
		harness.detectChanges();
		TestBed.tick();
		for (const request of http.match((request) =>
			request.url.endsWith('/lifecycle'),
		))
			request.flush({
				lifecycle: {
					analysisId: 'analysis-1',
					status: 'cancelled',
					stateVersion: 1,
					permanent: false,
					canCancel: false,
					canRetry: false,
					failure: null,
				},
			});
		http.expectOne('/api/v1/driving-analyses/analysis-1/clips').flush({
			clips: [
				{
					id: 'clip-1',
					cornerId: 'corner-1',
					ordinal: 1,
					segmentId: 'segment-1',
					status: 'not-ready',
					inputDigest: 'a'.repeat(64),
					checksum: null,
					durationMs: null,
					pipelineVersion: 'corner-render.v1',
				},
			],
		});
		const original = evidence.corners[0]?.passes[0];
		if (!original) throw new Error('missing pass fixture');
		http.expectOne('/api/v1/driving-analyses/analysis-1/evidence').flush({
			evidence: {
				...evidence,
				corners: [
					{ id: 'corner-2', name: 'Straight exit', order: 1, passes: [] },
					{
						...evidence.corners[0],
						passes: [
							{ ...original, rank: 2, tieGroup: 2, best: false },
							...(
								[
									'tracking-gap',
									'untrusted-crossing',
									'gate-order',
									'race-window',
								] as const
							).map((reason, index) => ({
								...original,
								ordinal: index + 2,
								eligibility: 'ineligible',
								exclusionReason: reason,
								durationMs: null,
								entry: null,
								exit: null,
								rank: null,
								tieGroup: null,
								best: false,
							})),
						],
					},
				],
			},
		});
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(root?.textContent).toContain('No accepted passes');
		expect(root?.textContent).toContain('Tracking lost the Subject car');
		expect(root?.textContent).toContain('could not be trusted');
		expect(root?.textContent).toContain('out of order');
		expect(root?.textContent).toContain('beyond the selected Race window');
		expect(root?.textContent).not.toContain('Best corner pass');
	});

	it.each([
		[401, 'Your session has expired'],
		[404, 'Driving analysis is unavailable'],
		[503, 'could not be loaded'],
	])(
		'shows safe HTTP %s failures and lets the user retry',
		async (status, message) => {
			const harness = open('analysis-1');
			http
				.expectOne('/api/v1/driving-analyses/analysis-1/evidence')
				.flush({}, { status: Number(status), statusText: 'Failed' });
			await harness.fixture.whenStable();
			harness.detectChanges();
			expect(
				harness.routeNativeElement?.querySelector('[role=alert]')?.textContent,
			).toContain(message);
			harness.routeNativeElement?.querySelector('button')?.click();
			harness.detectChanges();
			TestBed.tick();
			for (const request of http.match((request) =>
				request.url.endsWith('/lifecycle'),
			))
				request.flush({
					lifecycle: {
						analysisId: 'analysis-1',
						status: 'cancelled',
						stateVersion: 1,
						permanent: false,
						canCancel: false,
						canRetry: false,
						failure: null,
					},
				});
			http
				.expectOne('/api/v1/driving-analyses/analysis-1/clips')
				.flush({}, { status: 503, statusText: 'Unavailable' });
			http.expectOne('/api/v1/driving-analyses/analysis-1/evidence').flush({
				evidence: {
					...evidence,
					runId: null,
					tieToleranceMs: null,
					corners: [],
				},
			});
			await harness.fixture.whenStable();
			harness.detectChanges();
			expect(harness.routeNativeElement?.textContent).toContain(
				'No Corner evidence',
			);
		},
	);

	it('rejects invalid or private response fields instead of rendering them', async () => {
		const harness = open('analysis-1');
		http
			.expectOne('/api/v1/driving-analyses/analysis-1/evidence')
			.flush({ evidence: { ...evidence, objectKey: 'private-key' } });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'could not be loaded',
		);
		expect(harness.routeNativeElement?.textContent).not.toContain(
			'private-key',
		);
	});

	it('does not request evidence without an analysis identity', async () => {
		const harness = open('');
		await harness.fixture.whenStable();
		http.expectNone((request) => request.url.includes('/evidence'));
	});

	it('rejects inconsistent eligibility, ranking, and provenance at the gateway boundary', () => {
		const original = evidence.corners[0]?.passes[0];
		if (!original) throw new Error('missing pass fixture');
		for (const update of [
			{ entry: null },
			{ exit: null },
			{ durationMs: null },
			{ exclusionReason: 'tracking-gap' },
			{ rank: null },
			{ tieGroup: 2 },
			{ best: false },
			{ eligibility: 'ineligible' },
			{ eligibility: 'ineligible', durationMs: null },
			{
				eligibility: 'ineligible',
				durationMs: null,
				exclusionReason: 'tracking-gap',
			},
			{
				eligibility: 'ineligible',
				durationMs: null,
				exclusionReason: 'tracking-gap',
				rank: null,
			},
			{
				eligibility: 'ineligible',
				durationMs: null,
				exclusionReason: 'tracking-gap',
				rank: null,
				tieGroup: null,
			},
		])
			expect(
				cornerReviewResponseSchema.safeParse({
					evidence: {
						...evidence,
						corners: [
							{ ...evidence.corners[0], passes: [{ ...original, ...update }] },
						],
					},
				}).success,
			).toBe(false);
	});
});
