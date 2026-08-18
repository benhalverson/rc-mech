import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DrivingAnalysisGateway,
	drivingAnalysisGatewayFailure,
	parseDrivingAnalysis,
} from './driving-analysis-gateway';

const response = {
	drivingAnalysis: {
		id: '66666666-6666-4666-8666-666666666666',
		requestId: '55555555-5555-4555-8555-555555555555',
		carId: 'car-1',
		driveSessionId: 'drive-1',
		raceVideoId: '33333333-3333-4333-8333-333333333333',
		raceWindow: { startTimestampMs: 120_000, endTimestampMs: 720_000 },
		approvedTrackMapVersionId: '44444444-4444-4444-8444-444444444444',
		subjectSeed: {
			timestampMs: 180_000,
			frameIndex: 5_400,
			identity: 'subject-1',
			box: { x: 0.25, y: 0.4, width: 0.08, height: 0.06 },
		},
		sourceLayout: {
			version: 'fixed-track-view.v1',
			digest: 'a'.repeat(64),
			width: 1920,
			height: 1080,
			trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
		},
		lifecycle: 'preparation',
		status: 'queued',
		stage: 'preparation',
		progress: 0,
		stateVersion: 1,
		createdAt: '2026-08-17T18:00:00.000Z',
		updatedAt: '2026-08-17T18:00:00.000Z',
	},
} as const;

const command = {
	carId: 'car/one',
	driveSessionId: 'drive/one',
	requestId: response.drivingAnalysis.requestId,
	raceVideoId: response.drivingAnalysis.raceVideoId,
	approvedTrackMapVersionId: response.drivingAnalysis.approvedTrackMapVersionId,
	raceWindow: response.drivingAnalysis.raceWindow,
	subjectSeed: response.drivingAnalysis.subjectSeed,
};

describe('DrivingAnalysisGateway', () => {
	let gateway: DrivingAnalysisGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				DrivingAnalysisGateway,
			],
		});
		gateway = TestBed.inject(DrivingAnalysisGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('strictly parses immutable analysis and lifecycle facts', () => {
		expect(parseDrivingAnalysis(response)).toEqual(response.drivingAnalysis);
		for (const lifecycle of [
			{ status: 'running', stage: 'tracking', progress: 50 },
			{
				status: 'awaiting-reidentification',
				stage: 'tracking',
				progress: 50,
			},
			{ status: 'completed', stage: 'finalization', progress: 100 },
			{ status: 'failed', stage: 'preparation', progress: 0 },
			{ status: 'cancelled', stage: 'preparation', progress: 0 },
			{ status: 'deleting', stage: 'finalization', progress: 100 },
			{ status: 'deleted', stage: 'finalization', progress: 100 },
		] as const)
			expect(
				parseDrivingAnalysis({
					drivingAnalysis: { ...response.drivingAnalysis, ...lifecycle },
				}),
			).toMatchObject(lifecycle);
		for (const drivingAnalysis of [
			{ ...response.drivingAnalysis, progress: 101 },
			{
				...response.drivingAnalysis,
				subjectSeed: {
					...response.drivingAnalysis.subjectSeed,
					timestampMs: 100_000,
				},
			},
			{
				...response.drivingAnalysis,
				subjectSeed: {
					...response.drivingAnalysis.subjectSeed,
					timestampMs: 720_000,
				},
			},
			{ ...response.drivingAnalysis, stage: 'tracking' },
			{ ...response.drivingAnalysis, progress: 1 },
			{
				...response.drivingAnalysis,
				status: 'running',
				stage: 'finalization',
				progress: 100,
			},
			{
				...response.drivingAnalysis,
				status: 'completed',
				stage: 'finalization',
				progress: 99,
			},
			{
				...response.drivingAnalysis,
				status: 'awaiting-reidentification',
				stage: 'preparation',
				progress: 50,
			},
			{
				...response.drivingAnalysis,
				subjectSeed: {
					...response.drivingAnalysis.subjectSeed,
					box: { x: 0.99, y: 0.4, width: 0.08, height: 0.06 },
				},
			},
			{
				...response.drivingAnalysis,
				sourceLayout: {
					...response.drivingAnalysis.sourceLayout,
					trackView: { x: 0, y: 0, width: 1, height: 1 },
				},
			},
			{ ...response.drivingAnalysis, extra: true },
		])
			expect(() => parseDrivingAnalysis({ drivingAnalysis })).toThrow(
				'invalid',
			);
	});

	it('creates and refreshes one analysis with private authenticated requests', async () => {
		const created = firstValueFrom(gateway.create(command));
		let request = http.expectOne(
			'/api/v1/cars/car%2Fone/drives/drive%2Fone/driving-analyses',
		);
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({
			requestId: command.requestId,
			raceVideoId: command.raceVideoId,
			approvedTrackMapVersionId: command.approvedTrackMapVersionId,
			raceWindow: command.raceWindow,
			subjectSeed: command.subjectSeed,
		});
		request.flush(response, { status: 202, statusText: 'Accepted' });
		await expect(created).resolves.toEqual(response.drivingAnalysis);

		const retried = firstValueFrom(gateway.retry('analysis/one', 3));
		request = http.expectOne('/api/v1/driving-analyses/analysis%2Fone/retry');
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({ expectedStateVersion: 3 });
		request.flush(response, { status: 202, statusText: 'Accepted' });
		await expect(retried).resolves.toEqual(response.drivingAnalysis);

		gateway.selectAnalysis('analysis/one');
		gateway.analysis.value();
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/driving-analyses/analysis%2Fone');
		});
		expect(request.request.method).toBe('GET');
		expect(request.request.withCredentials).toBe(true);
		request.flush(response);
		await vi.waitFor(() =>
			expect(gateway.analysis.value()).toEqual(response.drivingAnalysis),
		);
		gateway.refresh();
		gateway.analysis.value();
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/driving-analyses/analysis%2Fone');
		});
		request.flush(response);
		gateway.selectAnalysis(null);
	});

	it('maps API, transport, parser, and unknown failures canonically', async () => {
		expect(
			drivingAnalysisGatewayFailure(new HttpErrorResponse({ status: 0 })),
		).toEqual({ kind: 'unavailable' });
		expect(
			drivingAnalysisGatewayFailure(
				new HttpErrorResponse({
					status: 409,
					error: { error: 'Request identity was reused.' },
				}),
			),
		).toEqual({
			kind: 'rejected-response',
			status: 409,
			message: 'Request identity was reused.',
		});
		expect(
			drivingAnalysisGatewayFailure(new HttpErrorResponse({ status: 503 })),
		).toEqual({ kind: 'http', status: 503 });
		let parserError: unknown;
		try {
			parseDrivingAnalysis({});
		} catch (error) {
			parserError = error;
		}
		expect(drivingAnalysisGatewayFailure(parserError)).toEqual({
			kind: 'invalid-response',
		});
		expect(drivingAnalysisGatewayFailure('offline')).toEqual({
			kind: 'unavailable',
		});

		const failed = firstValueFrom(gateway.create(command));
		http
			.expectOne('/api/v1/cars/car%2Fone/drives/drive%2Fone/driving-analyses')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await expect(failed).rejects.toEqual({ kind: 'http', status: 503 });

		gateway.selectAnalysis('analysis-1');
		gateway.analysis.value();
		let malformed: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			malformed = http.expectOne('/api/v1/driving-analyses/analysis-1');
		});
		if (!malformed) throw new Error('Analysis read was not issued.');
		malformed.flush({ drivingAnalysis: {} });
		await vi.waitFor(() =>
			expect(gateway.analysisFailure()).toEqual({ kind: 'invalid-response' }),
		);
	});
});
