import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarPhoto } from '../car.models';
import {
	CarPhotoGateway,
	parsePhotoCollection,
	parsePhotoDeletion,
	parsePhotoMutation,
	photoGatewayFailure,
} from './car-photo-gateway';

const photo = (overrides: Partial<CarPhoto> = {}): CarPhoto => ({
	id: 'photo-1',
	carId: 'car/1',
	contentType: 'image/webp',
	createdAt: '2026-08-09T18:00:00.000Z',
	sortOrder: 0,
	...overrides,
});

describe('CarPhotoGateway', () => {
	let gateway: CarPhotoGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				CarPhotoGateway,
			],
		});
		gateway = TestBed.inject(CarPhotoGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('parses each response shape and rejects malformed transport data', () => {
		expect(parsePhotoCollection({ photos: [photo()] }).photos).toHaveLength(1);
		expect(parsePhotoMutation({ photo: photo() })).toEqual(photo());
		expect(parsePhotoDeletion({ deleted: true })).toEqual({ deleted: true });
		expect(
			parsePhotoDeletion({ deleted: true, primaryPhotoId: 'photo-2' }),
		).toEqual({ deleted: true, primaryPhotoId: 'photo-2' });

		for (const parse of [
			() => parsePhotoCollection({ photos: [{ id: 4 }] }),
			() => parsePhotoMutation({ photo: {} }),
			() => parsePhotoDeletion({ deleted: 'yes' }),
		])
			expect(parse).toThrow();
	});

	it('maps unavailable, HTTP, and invalid-response failures canonically', () => {
		expect(photoGatewayFailure(new HttpErrorResponse({ status: 0 }))).toEqual({
			kind: 'unavailable',
		});
		expect(photoGatewayFailure(new HttpErrorResponse({ status: 403 }))).toEqual(
			{ kind: 'http', status: 403 },
		);
		expect(photoGatewayFailure('offline')).toEqual({ kind: 'unavailable' });

		let malformed: unknown;
		try {
			parsePhotoMutation({ photo: null });
		} catch (error) {
			malformed = error;
		}
		expect(photoGatewayFailure(malformed)).toEqual({
			kind: 'invalid-response',
		});
	});

	it('loads and refreshes the selected car gallery with credentials', async () => {
		gateway.collection.value();
		http.expectNone('/api/v1/cars/car%2F1/photos');
		expect(gateway.failure()).toBeNull();

		gateway.selectCar('car/1');
		gateway.selectCar('car/1');
		let request: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/cars/car%2F1/photos');
		});
		expect(request?.request.withCredentials).toBe(true);
		request?.flush({ photos: [photo()] });
		await vi.waitFor(() =>
			expect(gateway.collection.value()?.photos).toHaveLength(1),
		);

		gateway.refresh();
		let refresh: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/cars/car%2F1/photos');
		});
		refresh?.flush({ photos: [] });
	});

	it('surfaces a malformed gallery through the resource failure seam', async () => {
		gateway.selectCar('car-1');
		let request: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/cars/car-1/photos');
		});
		request?.flush({ photos: [{ id: 4 }] });
		await vi.waitFor(() => expect(gateway.collection.error()).toBeTruthy());
		expect(gateway.failure()).toEqual({ kind: 'invalid-response' });
	});

	it('uses encoded authenticated endpoints for every mutation', async () => {
		const file = new File(['image'], 'car.webp', { type: 'image/webp' });
		const uploaded = firstValueFrom(gateway.upload('car/1', file));
		const upload = http.expectOne('/api/v1/cars/car%2F1/photos');
		expect(upload.request.method).toBe('POST');
		expect(upload.request.withCredentials).toBe(true);
		expect(upload.request.body).toBeInstanceOf(FormData);
		expect((upload.request.body as FormData).get('file')).toBeInstanceOf(File);
		upload.flush({ photo: photo() });
		await expect(uploaded).resolves.toEqual(photo());

		const replacedPhoto = photo({ contentType: 'image/png' });
		const replaced = firstValueFrom(gateway.replace(photo(), file));
		const replace = http.expectOne(
			'/api/v1/cars/car%2F1/photos/photo-1/replace',
		);
		expect(replace.request.method).toBe('POST');
		replace.flush({ photo: replacedPhoto });
		await expect(replaced).resolves.toEqual(replacedPhoto);

		const primaryPhoto = photo({ isPrimary: true });
		const primary = firstValueFrom(gateway.setPrimary(photo()));
		const setPrimary = http.expectOne('/api/v1/cars/car%2F1/photos/photo-1');
		expect(setPrimary.request.method).toBe('PATCH');
		expect(setPrimary.request.body).toEqual({ isPrimary: true });
		setPrimary.flush({ photo: primaryPhoto });
		await expect(primary).resolves.toEqual(primaryPhoto);

		const deleted = firstValueFrom(gateway.delete(photo()));
		const remove = http.expectOne('/api/v1/cars/car%2F1/photos/photo-1');
		expect(remove.request.method).toBe('DELETE');
		remove.flush({ deleted: true, primaryPhotoId: 'photo-2' });
		await expect(deleted).resolves.toEqual({
			deleted: true,
			primaryPhotoId: 'photo-2',
		});

		const orderedPhotos = [
			photo({ id: 'photo/2', sortOrder: 0 }),
			photo({ sortOrder: 1 }),
		];
		const reordered = firstValueFrom(gateway.reorder('car/1', orderedPhotos));
		const reorder = http.expectOne('/api/v1/cars/car%2F1/photos/reorder');
		expect(reorder.request.method).toBe('PATCH');
		expect(reorder.request.body).toEqual({
			photoIds: ['photo/2', 'photo-1'],
		});
		reorder.flush({ photos: orderedPhotos });
		await expect(reordered).resolves.toEqual(orderedPhotos);
	});

	it('maps each mutation failure before exposing it to the store', async () => {
		const file = new File(['image'], 'car.webp', { type: 'image/webp' });
		const upload = firstValueFrom(gateway.upload('car-1', file));
		http
			.expectOne('/api/v1/cars/car-1/photos')
			.flush('offline', { status: 0, statusText: 'Offline' });
		await expect(upload).rejects.toEqual({ kind: 'unavailable' });

		const primary = firstValueFrom(gateway.setPrimary(photo()));
		http
			.expectOne('/api/v1/cars/car%2F1/photos/photo-1')
			.flush('forbidden', { status: 403, statusText: 'Forbidden' });
		await expect(primary).rejects.toEqual({ kind: 'http', status: 403 });

		const deletion = firstValueFrom(gateway.delete(photo()));
		http
			.expectOne('/api/v1/cars/car%2F1/photos/photo-1')
			.flush({ deleted: 'yes' });
		await expect(deletion).rejects.toEqual({ kind: 'invalid-response' });

		const reorder = firstValueFrom(gateway.reorder('car-1', [photo()]));
		http
			.expectOne('/api/v1/cars/car-1/photos/reorder')
			.flush({ photos: [{ id: 4 }] });
		await expect(reorder).rejects.toEqual({ kind: 'invalid-response' });
	});
});
