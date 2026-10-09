import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PhotoCapture } from './photo-sync.models';
import { PhotoSyncGateway, photoSyncFailure } from './photo-sync-gateway';

const capture: PhotoCapture = {
	ownerKey: 'owner',
	operationId: 'capture',
	carId: 'car',
	fileName: 'car.jpg',
	blob: new Blob(['image'], { type: 'image/jpeg' }),
	photo: {
		id: 'capture',
		carId: 'car',
		contentType: 'image/jpeg',
		createdAt: 'now',
	},
	status: 'pending',
};
const endpoint = '/api/v1/cars/car/photos/captures/capture';
describe('PhotoSyncGateway', () => {
	let gateway: PhotoSyncGateway;
	let http: HttpTestingController;
	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [provideHttpClient(), provideHttpClientTesting()],
		});
		gateway = TestBed.inject(PhotoSyncGateway);
		http = TestBed.inject(HttpTestingController);
	});
	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});
	it('sends immutable bytes with stable identity and validates acknowledgement', async () => {
		const result = firstValueFrom(gateway.apply(capture));
		const request = http.expectOne(endpoint);
		expect(request.request.method).toBe('PUT');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body.get('file').name).toBe('car.jpg');
		request.flush({
			operationId: 'capture',
			outcome: 'applied',
			photo: capture.photo,
		});
		expect(await result).toMatchObject({ outcome: 'applied' });
		for (const photo of [
			{ ...capture.photo, id: 'wrong' },
			{ ...capture.photo, carId: 'wrong' },
			{},
		]) {
			const invalid = firstValueFrom(gateway.apply(capture));
			const rejected = expect(invalid).rejects.toEqual({
				kind: 'invalid-response',
			});
			http
				.expectOne(endpoint)
				.flush({ operationId: 'capture', outcome: 'applied', photo });
			await rejected;
		}
	});
	it('retains canonical rejection and distinguishes retryable failures', async () => {
		const result = firstValueFrom(gateway.apply(capture));
		http
			.expectOne(endpoint)
			.flush(
				{ error: 'Car archived' },
				{ status: 409, statusText: 'Conflict' },
			);
		expect(await result).toEqual({
			operationId: 'capture',
			outcome: 'rejected',
			error: 'Car archived',
		});
		for (const status of [400, 503, 0]) {
			const result = firstValueFrom(gateway.apply(capture));
			const rejected = expect(result).rejects.toEqual({
				kind: status === 400 ? 'invalid-response' : 'unavailable',
			});
			const request = http.expectOne(endpoint);
			if (status === 0) request.error(new ProgressEvent('error'));
			else request.flush({}, { status, statusText: 'error' });
			await rejected;
		}
		expect(photoSyncFailure(new HttpErrorResponse({ status: 403 }))).toEqual({
			kind: 'invalid-response',
		});
	});
	it('loads validated metadata and private original bytes', async () => {
		const metadata = firstValueFrom(gateway.metadata());
		http.expectOne('/api/v1/photos').flush({ photos: [capture.photo] });
		expect(await metadata).toEqual([capture.photo]);
		const original = firstValueFrom(gateway.original('capture'));
		const blob = capture.blob;
		http.expectOne('/api/v1/photos/capture').flush(blob);
		expect(await original).toEqual({ blob, revision: 1 });
		const invalid = firstValueFrom(gateway.metadata());
		const rejected = expect(invalid).rejects.toEqual({
			kind: 'invalid-response',
		});
		http.expectOne('/api/v1/photos').flush({ photos: null });
		await rejected;
		const failure = firstValueFrom(gateway.original('capture'));
		const unavailable = expect(failure).rejects.toEqual({
			kind: 'unavailable',
		});
		http.expectOne('/api/v1/photos/capture').error(new ProgressEvent('error'));
		await unavailable;
	});
	it('persists gallery change identities and replacement bytes, parsing only owner-scoped outcomes', async () => {
		const operation: import('./photo-sync.models').PhotoChangeOperation = {
			ownerKey: 'owner',
			operationId: 'change',
			carId: 'car',
			createdAt: 1,
			status: 'pending',
			dependencies: [],
			command: {
				type: 'photo.change',
				carId: 'car',
				action: 'replace',
				photoId: 'capture',
				order: [],
				base: [{ id: 'capture', revision: 1 }],
				replacement: {
					fileName: 'car.jpg',
					contentType: 'image/jpeg',
					byteSize: 5,
				},
			},
			blob: capture.blob,
		};
		const url = '/api/v1/cars/car/photos/operations/change';
		const response = firstValueFrom(gateway.change(operation));
		const request = http.expectOne(url);
		expect(request.request.method).toBe('PUT');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body.get('file').size).toBe(5);
		expect(JSON.parse(request.request.body.get('command'))).toEqual(
			operation.command,
		);
		request.flush({
			operationId: 'change',
			outcome: 'applied',
			photos: [capture.photo],
		});
		expect(await response).toMatchObject({ outcome: 'applied' });
		for (const remote of [undefined, [capture.photo]]) {
			const result = firstValueFrom(
				gateway.change({ ...operation, blob: undefined }),
			);
			http.expectOne(url).flush(
				{
					operationId: 'change',
					outcome: 'conflict',
					error: { code: 'CONFLICT', message: 'Changed' },
					remote,
				},
				{ status: 409, statusText: 'Conflict' },
			);
			expect(await result).toMatchObject({ outcome: 'conflict' });
		}
		for (const [body, status] of [
			[
				{
					operationId: 'change',
					outcome: 'applied',
					photos: [{ ...capture.photo, carId: 'other' }],
				},
				200,
			],
			[{}, 200],
			[{}, 409],
			[
				{
					operationId: 'change',
					outcome: 'conflict',
					error: { code: 'CONFLICT', message: 'Changed' },
					remote: [{ ...capture.photo, carId: 'other' }],
				},
				409,
			],
			[{}, 503],
		] as const) {
			const result = firstValueFrom(
				gateway.change({
					...operation,
					command: { ...operation.command, replacement: null },
				}),
			);
			const rejected = expect(result).rejects.toEqual({
				kind: status === 503 ? 'unavailable' : 'invalid-response',
			});
			http.expectOne(url).flush(body, { status, statusText: 'Error' });
			await rejected;
		}
	});
	it('validates the original revision before retaining private bytes', async () => {
		for (const revision of ['2', 'invalid', '0', '1.5']) {
			const result = firstValueFrom(gateway.original('capture'));
			const rejected =
				revision === '2'
					? null
					: expect(result).rejects.toEqual({ kind: 'invalid-response' });
			http.expectOne('/api/v1/photos/capture').flush(new Blob(['image']), {
				headers: { 'X-Photo-Revision': revision },
			});
			if (rejected) await rejected;
			else expect(await result).toMatchObject({ revision: 2 });
		}
		const result = firstValueFrom(gateway.original('capture'));
		const rejected = expect(result).rejects.toEqual({
			kind: 'invalid-response',
		});
		http.expectOne('/api/v1/photos/capture').flush(null);
		await rejected;
	});
});
