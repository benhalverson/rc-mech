import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnalysisLifecycle } from './analysis-lifecycle-gateway';
import { CornerReview } from './corner-review';
import { CornerReviewStore } from './corner-review-store';

const state = (status: AnalysisLifecycle['status']): AnalysisLifecycle => ({
	analysisId: 'analysis-1',
	stateVersion: 1,
	status,
	permanent: status === 'deleted',
	canCancel: status === 'running',
	canRetry: status === 'completed',
	failure:
		status === 'failed'
			? { code: 'PROCESSING_REJECTED', retryable: false }
			: null,
});
const analysis = {
	id: 'analysis-1',
	requestId: 'request-1',
	carId: 'car-1',
	driveSessionId: 'drive-1',
	raceVideoId: 'video-1',
	raceWindow: { startTimestampMs: 0, endTimestampMs: 1000 },
	approvedTrackMapVersionId: 'map-1',
	subjectSeed: {
		timestampMs: 0,
		frameIndex: 0,
		identity: 'subject-1',
		box: { x: 0, y: 0, width: 0.1, height: 0.1 },
	},
	sourceLayout: {
		version: 'fixed-track-view.v1',
		digest: 'a'.repeat(64),
		width: 320,
		height: 180,
		trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
	},
	lifecycle: 'preparation',
	status: 'queued',
	stage: 'preparation',
	progress: 0,
	stateVersion: 1,
	createdAt: '2026-08-17T18:00:00.000Z',
	updatedAt: '2026-08-17T18:00:00.000Z',
};

describe('Analysis lifecycle controls', () => {
	let http: HttpTestingController;
	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter([]),
				CornerReviewStore,
			],
		});
		http = TestBed.inject(HttpTestingController);
	});
	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});
	const flushReads = (lifecycle: AnalysisLifecycle) => {
		TestBed.tick();
		for (const request of http.match((request) =>
			request.url.endsWith('/clips'),
		))
			request.flush({ clips: [] });
		for (const request of http.match((request) =>
			request.url.endsWith('/lifecycle'),
		))
			request.flush({ lifecycle });
		for (const request of http.match((request) =>
			request.url.endsWith('/evidence'),
		))
			request.flush({
				evidence: {
					analysisId: 'analysis-1',
					carId: 'car-1',
					driveSessionId: 'drive-1',
					stateVersion: 1,
					status: 'running',
					runId: null,
					trackMapVersionId: 'map-1',
					tieToleranceMs: null,
					corners: [],
				},
			});
	};
	it('reports lifecycle read failures safely and recovers through Refresh', async () => {
		const fixture = TestBed.createComponent(CornerReview);
		fixture.componentRef.setInput('analysisId', 'analysis-1');
		fixture.detectChanges();
		TestBed.tick();
		http
			.expectOne('/api/v1/driving-analyses/analysis-1/lifecycle')
			.flush(
				{ error: 'private provider diagnostics' },
				{ status: 503, statusText: 'Unavailable' },
			);
		flushReads(state('running'));
		await fixture.whenStable();
		fixture.detectChanges();
		const root: HTMLElement = fixture.nativeElement;
		expect(root.textContent).toContain('Analysis controls could not be loaded');
		expect(root.textContent).not.toContain('private provider');
		Array.from(root.querySelectorAll('button'))
			.find((button) => button.textContent?.trim() === 'Refresh evidence')
			?.click();
		flushReads(state('running'));
		await fixture.whenStable();
		fixture.detectChanges();
		expect(root.textContent).not.toContain(
			'Analysis controls could not be loaded',
		);
		expect(root.textContent).toContain('Cancel analysis');
	});
	it('cancels, replays failed retry commands, and confirms permanent deletion', async () => {
		const store = TestBed.inject(CornerReviewStore);
		store.changeLifecycle({ action: 'cancel' });
		const fixture = TestBed.createComponent(CornerReview);
		fixture.componentRef.setInput('analysisId', 'analysis-1');
		fixture.detectChanges();
		flushReads(state('running'));
		await fixture.whenStable();
		fixture.detectChanges();
		const root: HTMLElement = fixture.nativeElement;
		const click = (label: string) => {
			const button = Array.from(root.querySelectorAll('button')).find(
				(element) => element.textContent?.trim() === label,
			);
			expect(button).toBeDefined();
			button?.click();
			fixture.detectChanges();
		};
		click('Cancel analysis');
		store.changeLifecycle({ action: 'cancel' });
		const cancel = http.expectOne('/api/v1/driving-analyses/analysis-1/cancel');
		expect(cancel.request.body).toEqual({ expectedStateVersion: 1 });
		cancel.flush({ drivingAnalysis: analysis });
		flushReads(state('completed'));
		await fixture.whenStable();
		fixture.detectChanges();
		click('Retry as a new run');
		const first = http.expectOne('/api/v1/driving-analyses/analysis-1/retry');
		const commandId = first.request.body.commandId;
		expect(commandId).toMatch(/^[0-9a-f-]{36}$/);
		first.flush({}, { status: 503, statusText: 'Unavailable' });
		fixture.detectChanges();
		expect(root.textContent).toContain('could not be completed');
		click('Retry as a new run');
		const second = http.expectOne('/api/v1/driving-analyses/analysis-1/retry');
		expect(second.request.body.commandId).toBe(commandId);
		second.flush({ drivingAnalysis: analysis });
		flushReads(state('cancelled'));
		await fixture.whenStable();
		fixture.detectChanges();
		click('Delete analysis');
		expect(root.textContent).toContain('Your source Race recording is kept');
		click('Keep analysis');
		expect(root.textContent).not.toContain('Confirm deletion');
		click('Delete analysis');
		click('Confirm deletion');
		const deletion = http.expectOne('/api/v1/driving-analyses/analysis-1');
		expect(deletion.request.method).toBe('DELETE');
		expect(deletion.request.withCredentials).toBe(true);
		deletion.flush({ lifecycle: state('deleting') });
		flushReads(state('deleting'));
		await fixture.whenStable();
		fixture.detectChanges();
		expect(root.textContent).toContain('cleanup will retry automatically');
		expect(store.review()).toBeNull();
		store.refresh();
		flushReads(state('deleted'));
		await fixture.whenStable();
		fixture.detectChanges();
		expect(root.textContent).toContain('permanently deleted');
		expect(store.review()).toBeNull();
	});
	it('shows safe terminal and retryable lifecycle failures', async () => {
		const fixture = TestBed.createComponent(CornerReview);
		fixture.componentRef.setInput('analysisId', 'analysis-1');
		fixture.detectChanges();
		flushReads(state('failed'));
		await fixture.whenStable();
		fixture.detectChanges();
		const root: HTMLElement = fixture.nativeElement;
		expect(root.textContent).toContain('cannot be retried');
		TestBed.inject(CornerReviewStore).refresh();
		flushReads({
			...state('failed'),
			failure: { code: 'PROCESSING_UNAVAILABLE', retryable: true },
		});
		await fixture.whenStable();
		fixture.detectChanges();
		expect(root.textContent).toContain('temporarily unavailable');
	});
});
