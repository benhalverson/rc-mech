import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GarageCar } from './garage.models';
import {
	GarageGateway,
	garageGatewayFailure,
	parseGarageCollection,
	parseGarageMutation,
} from './garage-gateway';

const car = (overrides: Partial<GarageCar> = {}): GarageCar => ({
	id: 'car-1',
	name: 'Red Runner',
	...overrides,
});

describe('GarageGateway', () => {
	let gateway: GarageGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				GarageGateway,
			],
		});
		gateway = TestBed.inject(GarageGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('parses nullable collections and canonical mutation responses', () => {
		expect(parseGarageCollection(null)).toEqual({ cars: [] });
		expect(parseGarageCollection({ cars: [car()] })).toEqual({ cars: [car()] });
		expect(parseGarageMutation({ car: car() })).toEqual(car());
		expect(() => parseGarageCollection({ cars: [{ id: '' }] })).toThrow();
		expect(() => parseGarageMutation({ car: { id: 4 } })).toThrow();
	});

	it('maps HTTP, unavailable, and invalid-response failures', () => {
		expect(garageGatewayFailure(new HttpErrorResponse({ status: 0 }))).toEqual({
			kind: 'unavailable',
		});
		expect(
			garageGatewayFailure(new HttpErrorResponse({ status: 401 })),
		).toEqual({ kind: 'http', status: 401 });
		expect(garageGatewayFailure('offline')).toEqual({ kind: 'unavailable' });
		let malformed: unknown;
		try {
			parseGarageMutation({ car: null });
		} catch (error) {
			malformed = error;
		}
		expect(garageGatewayFailure(malformed)).toEqual({
			kind: 'invalid-response',
		});
	});

	it('loads active and archived collections and refreshes the current filter', async () => {
		gateway.collection.value();
		let active: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			active = http.expectOne(
				(request) =>
					request.url === '/api/v1/cars' && !request.params.has('archived'),
			);
		});
		expect(active?.request.withCredentials).toBe(true);
		active?.flush({ cars: [car()] });
		await vi.waitFor(() =>
			expect(gateway.collection.value()?.cars).toHaveLength(1),
		);
		expect(gateway.collectionFailure()).toBeNull();

		gateway.setShowArchived(true);
		let archived: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			archived = http.expectOne(
				(request) => request.params.get('archived') === 'all',
			);
		});
		archived?.flush({ cars: [car({ archivedAt: '2026-08-01' })] });
		await vi.waitFor(() =>
			expect(gateway.collection.value()?.cars[0]?.archivedAt).toBe(
				'2026-08-01',
			),
		);

		gateway.refresh();
		let refresh: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne(
				(request) => request.params.get('archived') === 'all',
			);
		});
		refresh?.flush({ cars: [] });
	});

	it('surfaces malformed collection data and creates authenticated cars', async () => {
		gateway.collection.value();
		let read: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			read = http.expectOne('/api/v1/cars');
		});
		read?.flush({ cars: [{ id: 4 }] });
		await vi.waitFor(() => expect(gateway.collection.error()).toBeTruthy());
		expect(gateway.collectionFailure()).toEqual({ kind: 'invalid-response' });

		const created = firstValueFrom(gateway.createCar({ name: 'Blue Buggy' }));
		const create = http.expectOne('/api/v1/cars');
		expect(create.request.method).toBe('POST');
		expect(create.request.withCredentials).toBe(true);
		expect(create.request.body).toEqual({ name: 'Blue Buggy' });
		create.flush({ car: car({ id: 'car-2', name: 'Blue Buggy' }) });
		await expect(created).resolves.toMatchObject({ id: 'car-2' });

		const malformed = firstValueFrom(gateway.createCar({ name: 'Bad' }));
		http.expectOne('/api/v1/cars').flush({ car: { id: 4 } });
		await expect(malformed).rejects.toEqual({ kind: 'invalid-response' });
	});
});
