import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingVoiceCapture, VoiceUpdate } from './voice.models';
import {
	parseVoiceContextCars,
	parseVoiceMutation,
	parseVoiceUpdates,
	VoiceGateway,
	voiceGatewayFailure,
} from './voice-gateway';

const update = (overrides: Partial<VoiceUpdate> = {}): VoiceUpdate => ({
	id: 'voice-1',
	carId: 'car-1',
	driveSessionId: null,
	status: 'needs-review',
	contentType: 'audio/webm',
	fileName: 'voice.webm',
	byteSize: 10,
	audioUrl: '/audio/voice-1',
	transcript: 'Changed rear shock oil to 35 wt.',
	draft: {
		setupChanges: [],
		problems: [],
		conditions: [],
		driveSessionNotes: [],
		consumables: [],
		unmappedNotes: [],
		unresolvedNotes: [],
	},
	corrections: [],
	clarificationPrompt: null,
	error: null,
	confirmedAt: null,
	artifactDeletedAt: null,
	createdAt: '2026-08-09T01:00:00.000Z',
	updatedAt: '2026-08-09T01:00:00.000Z',
	results: [],
	...overrides,
});

const capture = (
	overrides: Partial<PendingVoiceCapture> = {},
): PendingVoiceCapture => ({
	id: 'capture-1',
	ownerKey: 'owner@example.test',
	carId: 'car/one',
	driveSessionId: null,
	text: 'Track note',
	contentType: 'text/plain',
	fileName: 'voice.txt',
	createdAt: '2026-08-09T01:00:00.000Z',
	status: 'local',
	error: null,
	...overrides,
});

describe('VoiceGateway', () => {
	let gateway: VoiceGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				VoiceGateway,
			],
		});
		gateway = TestBed.inject(VoiceGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('parses canonical reads and rejects malformed transport data', () => {
		expect(parseVoiceUpdates({ voiceUpdates: [update()] })).toHaveLength(1);
		expect(
			parseVoiceContextCars({
				cars: [
					{ id: 'car-1', name: 'Buggy', archivedAt: null },
					{ id: 'car-2', name: 'Archived', archivedAt: 'now' },
				],
			}),
		).toEqual([{ id: 'car-1', name: 'Buggy', archivedAt: null }]);
		expect(
			parseVoiceMutation({
				voiceUpdate: update(),
				correction: { outcome: 'manual-note' },
			}),
		).toMatchObject({ correction: { outcome: 'manual-note' } });
		expect(() => parseVoiceUpdates({ voiceUpdates: [42] })).toThrow('invalid');
		expect(() => parseVoiceContextCars({ cars: [{ id: 1 }] })).toThrow(
			'invalid',
		);
		expect(() => parseVoiceMutation({ status: true })).toThrow('invalid');
	});

	it('maps unavailable, rejected, HTTP, invalid, and unknown failures', () => {
		expect(voiceGatewayFailure(new HttpErrorResponse({ status: 0 }))).toEqual({
			kind: 'unavailable',
		});
		expect(
			voiceGatewayFailure(
				new HttpErrorResponse({
					status: 422,
					error: { error: 'That context is unavailable.' },
				}),
			),
		).toEqual({
			kind: 'rejected-response',
			status: 422,
			message: 'That context is unavailable.',
		});
		expect(voiceGatewayFailure(new HttpErrorResponse({ status: 503 }))).toEqual(
			{ kind: 'http', status: 503 },
		);
		let parserError: unknown;
		try {
			parseVoiceMutation({});
		} catch (error) {
			parserError = error;
		}
		expect(voiceGatewayFailure(parserError)).toEqual({
			kind: 'invalid-response',
		});
		expect(voiceGatewayFailure('offline')).toEqual({ kind: 'unavailable' });
	});

	it('owns authenticated reads, route selection, failures, and refresh', async () => {
		expect(gateway.updatesFailure()).toBeNull();
		gateway.selectCar('car/one');
		gateway.selectCar('car/one');
		gateway.contextCars.isLoading();
		gateway.updates.isLoading();
		let cars: ReturnType<HttpTestingController['expectOne']> | undefined;
		let updates: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			cars = http.expectOne('/api/v1/cars');
			updates = http.expectOne('/api/v1/cars/car%2Fone/voice-updates');
		});
		if (!cars || !updates) throw new Error('Voice reads were not issued.');
		expect(cars.request.withCredentials).toBe(true);
		cars.flush({ cars: [{ id: 'car/one', name: 'Buggy', archivedAt: null }] });
		expect(updates.request.withCredentials).toBe(true);
		updates.flush({ voiceUpdates: [update({ carId: 'car/one' })] });
		await vi.waitFor(() => expect(gateway.updates.value()).toHaveLength(1));

		gateway.refresh();
		await vi.waitFor(() => {
			updates = http.expectOne('/api/v1/cars/car%2Fone/voice-updates');
		});
		updates.flush({ voiceUpdates: [] });
		await vi.waitFor(() => expect(gateway.updates.value()).toEqual([]));
		gateway.refresh();
		await vi.waitFor(() => {
			updates = http.expectOne('/api/v1/cars/car%2Fone/voice-updates');
		});
		updates.flush('bad', { status: 401, statusText: 'Unauthorized' });
		await vi.waitFor(() =>
			expect(gateway.updatesFailure()).toMatchObject({ status: 401 }),
		);
	});

	it('uploads text and audio with credentials and exact payloads', async () => {
		let result = firstValueFrom(gateway.upload(capture()));
		let request = http.expectOne('/api/v1/cars/car%2Fone/voice-updates');
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({
			captureId: 'capture-1',
			text: 'Track note',
			driveSessionId: null,
		});
		request.flush({ voiceUpdate: update() });
		await expect(result).resolves.toMatchObject({
			voiceUpdate: { id: 'voice-1' },
		});

		result = firstValueFrom(
			gateway.upload(
				capture({
					blob: new Blob(['voice'], { type: 'audio/mp4' }),
					text: undefined,
					driveSessionId: 'drive-1',
					contentType: 'audio/mp4',
					fileName: 'voice.m4a',
				}),
			),
		);
		request = http.expectOne('/api/v1/cars/car%2Fone/voice-updates');
		const body = request.request.body as FormData;
		expect(body.get('captureId')).toBe('capture-1');
		expect(body.get('driveSessionId')).toBe('drive-1');
		expect(body.get('file')).toBeInstanceOf(File);
		request.flush({ voiceUpdate: update() });
		await expect(result).resolves.toBeTruthy();

		result = firstValueFrom(
			gateway.upload(
				capture({
					blob: new Blob(['voice']),
					text: undefined,
					contentType: 'audio/webm',
				}),
			),
		);
		request = http.expectOne('/api/v1/cars/car%2Fone/voice-updates');
		expect((request.request.body as FormData).has('driveSessionId')).toBe(
			false,
		);
		request.flush({ voiceUpdate: update() });
		await result;
	});

	it('issues every cold review mutation and parses responses', async () => {
		const cases = [
			{
				result: firstValueFrom(gateway.process('voice/1')),
				method: 'POST',
				url: '/api/v1/voice-updates/voice%2F1/process',
				body: {},
			},
			{
				result: firstValueFrom(
					gateway.correctText('voice/1', 'Rear, not front'),
				),
				method: 'POST',
				url: '/api/v1/voice-updates/voice%2F1/corrections',
				body: { text: 'Rear, not front' },
			},
			{
				result: firstValueFrom(gateway.confirm('voice/1', true)),
				method: 'POST',
				url: '/api/v1/voice-updates/voice%2F1/confirm',
				body: { acceptUnresolvedAsNotes: true },
			},
			{
				result: firstValueFrom(gateway.updateContext('voice/1', 'car-2', null)),
				method: 'PATCH',
				url: '/api/v1/voice-updates/voice%2F1',
				body: { carId: 'car-2', driveSessionId: null },
			},
			{
				result: firstValueFrom(gateway.discard('voice/1')),
				method: 'DELETE',
				url: '/api/v1/voice-updates/voice%2F1',
				body: null,
			},
		];
		for (const item of cases) {
			const request = http.expectOne(
				(candidate) =>
					candidate.url === item.url && candidate.method === item.method,
			);
			expect(request.request.method).toBe(item.method);
			expect(request.request.withCredentials).toBe(true);
			if (item.method !== 'DELETE')
				expect(request.request.body).toEqual(item.body);
			request.flush({ voiceUpdate: update() });
			await expect(item.result).resolves.toBeTruthy();
		}

		const audio = firstValueFrom(
			gateway.correctAudio('voice/1', new Blob(['fix'])),
		);
		const audioRequest = http.expectOne(
			'/api/v1/voice-updates/voice%2F1/corrections',
		);
		expect(audioRequest.request.body).toBeInstanceOf(FormData);
		audioRequest.flush({ voiceUpdate: update() });
		await audio;
	});

	it('canonicalizes malformed and rejected mutation responses', async () => {
		let result = firstValueFrom(gateway.process('voice-1'));
		http
			.expectOne('/api/v1/voice-updates/voice-1/process')
			.flush({ status: true });
		await expect(result).rejects.toEqual({ kind: 'invalid-response' });

		result = firstValueFrom(gateway.process('voice-1'));
		http
			.expectOne('/api/v1/voice-updates/voice-1/process')
			.flush(
				{ error: 'Review this draft first.' },
				{ status: 409, statusText: 'Conflict' },
			);
		await expect(result).rejects.toEqual({
			kind: 'rejected-response',
			status: 409,
			message: 'Review this draft first.',
		});
	});
});
