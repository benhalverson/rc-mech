import {
	HttpClient,
	HttpErrorResponse,
	provideHttpClient,
} from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
		expect(await original).toBe(blob);
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
	it.each([401, 403, 404, 503])(
		'preserves original HTTP failure status %s',
		async (status) => {
			const result = firstValueFrom(gateway.original('capture'));
			const rejected = expect(result).rejects.toEqual({ kind: 'http', status });
			http
				.expectOne('/api/v1/photos/capture')
				.flush(null, { status, statusText: 'Error' });
			await rejected;
		},
	);
	it('preserves an unexpected HTTP-stack failure for diagnostics', async () => {
		const failure = new Error('HTTP interceptor failed');
		const request = vi
			.spyOn(TestBed.inject(HttpClient), 'get')
			.mockReturnValueOnce(throwError(() => failure));
		await expect(firstValueFrom(gateway.original('capture'))).rejects.toBe(
			failure,
		);
		request.mockRestore();
	});
});
