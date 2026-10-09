import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	voiceCaptureFixture as capture,
	voiceUpdateFixture as update,
} from './voice-sync.testing';
import { VoiceSyncGateway } from './voice-sync-gateway';

describe('VoiceSyncGateway', () => {
	let gateway: VoiceSyncGateway;
	let http: HttpTestingController;
	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [provideHttpClient(), provideHttpClientTesting()],
		});
		gateway = TestBed.inject(VoiceSyncGateway);
		http = TestBed.inject(HttpTestingController);
	});
	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});
	it('loads metadata and uploads stable text context with credentials', async () => {
		const read = firstValueFrom(gateway.load());
		const request = http.expectOne('/api/v1/voice-updates');
		expect(request.request.withCredentials).toBe(true);
		request.flush({ voiceUpdates: [update] });
		expect(await read).toEqual([update]);
		const upload = firstValueFrom(gateway.upload(capture));
		const post = http.expectOne('/api/v1/cars/car/voice-updates');
		expect(post.request.body).toEqual({
			captureId: 'capture',
			text: capture.text,
			driveSessionId: null,
		});
		expect(post.request.withCredentials).toBe(true);
		post.flush({ voiceUpdate: update });
		expect(await upload).toEqual({ voiceUpdate: update });
	});
	it.each([null, 'drive'])(
		'preserves original audio bytes and optional Drive context %s',
		async (driveSessionId) => {
			const blob = new Blob([new Uint8Array([1, 2, 3, 254])], {
				type: 'audio/webm',
			});
			const result = firstValueFrom(
				gateway.upload({
					...capture,
					blob,
					driveSessionId,
					fileName: 'original.webm',
					contentType: blob.type,
				}),
			);
			const request = http.expectOne('/api/v1/cars/car/voice-updates');
			const file = (request.request.body as FormData).get('file') as File;
			expect(file.name).toBe('original.webm');
			expect(file.type).toBe('audio/webm');
			const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result as ArrayBuffer);
				reader.onerror = () => reject(reader.error);
				reader.readAsArrayBuffer(file);
			});
			expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3, 254]);
			expect((request.request.body as FormData).get('driveSessionId')).toBe(
				driveSessionId,
			);
			request.flush({ voiceUpdate: { ...update, driveSessionId } });
			await result;
		},
	);
	it.each([
		{ ...update, id: 'other' },
		{ ...update, carId: 'other' },
		{ ...update, driveSessionId: 'other' },
		null,
	])(
		'rejects malformed or misdirected upload acknowledgements',
		async (value) => {
			const promise = firstValueFrom(gateway.upload(capture));
			const rejected = expect(promise).rejects.toEqual({
				kind: 'invalid-response',
			});
			http
				.expectOne('/api/v1/cars/car/voice-updates')
				.flush({ voiceUpdate: value });
			await rejected;
		},
	);
	it('distinguishes transient failures from canonical processing rejection', async () => {
		for (const [status, error, wanted] of [
			[503, { error: 'Proxy unavailable' }, { kind: 'unavailable' }],
			[
				422,
				{ error: 'Car archived' },
				{ kind: 'rejected-response', status: 422, message: 'Car archived' },
			],
		] as const) {
			const promise = firstValueFrom(gateway.upload(capture));
			const rejected = expect(promise).rejects.toEqual(wanted);
			http
				.expectOne('/api/v1/cars/car/voice-updates')
				.flush(error, { status, statusText: 'Error' });
			await rejected;
		}
		for (const [body, wanted] of [
			[{}, { kind: 'unavailable' }],
			[
				{ voiceUpdate: { ...update, id: 'other', status: 'failed' } },
				{ kind: 'unavailable' },
			],
			[
				{ voiceUpdate: { ...update, status: 'pending' } },
				{ kind: 'unavailable' },
			],
			[
				{
					voiceUpdate: {
						...update,
						status: 'failed',
						error: 'Model could not transcribe',
					},
				},
				{
					kind: 'rejected-response',
					status: 502,
					message: 'Model could not transcribe',
				},
			],
			[
				{ voiceUpdate: { ...update, status: 'failed' } },
				{
					kind: 'rejected-response',
					status: 502,
					message:
						'Voice processing failed. The original recording remains saved.',
				},
			],
		] as const) {
			const promise = firstValueFrom(gateway.process('capture'));
			const rejected = expect(promise).rejects.toEqual(wanted);
			http
				.expectOne('/api/v1/voice-updates/capture/process')
				.flush(body, { status: 502, statusText: 'Error' });
			await rejected;
		}
	});
	it('validates processing identity and returns the server draft', async () => {
		const promise = firstValueFrom(gateway.process('capture'));
		http
			.expectOne('/api/v1/voice-updates/capture/process')
			.flush({ voiceUpdate: { ...update, status: 'needs-review' } });
		expect((await promise).voiceUpdate.status).toBe('needs-review');
		const wrong = firstValueFrom(gateway.process('capture'));
		const rejected = expect(wrong).rejects.toEqual({
			kind: 'invalid-response',
		});
		http
			.expectOne('/api/v1/voice-updates/capture/process')
			.flush({ voiceUpdate: { ...update, id: 'other' } });
		await rejected;
	});
});
