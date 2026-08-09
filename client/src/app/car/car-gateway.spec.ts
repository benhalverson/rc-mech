import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GarageCar } from '../garage/garage.models';
import { CarGateway, carGatewayFailure, parseCarResponse } from './car-gateway';

const car = (overrides: Partial<GarageCar> = {}): GarageCar => ({
	id: 'car/1',
	name: 'Red Runner',
	...overrides,
});

describe('CarGateway', () => {
	let gateway: CarGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [provideHttpClient(), provideHttpClientTesting(), CarGateway],
		});
		gateway = TestBed.inject(CarGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('parses car responses and maps every canonical failure', () => {
		expect(parseCarResponse({ car: car() })).toEqual(car());
		expect(() => parseCarResponse({ car: { id: 4 } })).toThrow();
		expect(carGatewayFailure(new HttpErrorResponse({ status: 0 }))).toEqual({
			kind: 'unavailable',
		});
		expect(carGatewayFailure(new HttpErrorResponse({ status: 404 }))).toEqual({
			kind: 'http',
			status: 404,
		});
		expect(carGatewayFailure('offline')).toEqual({ kind: 'unavailable' });
		let malformed: unknown;
		try {
			parseCarResponse({});
		} catch (error) {
			malformed = error;
		}
		expect(carGatewayFailure(malformed)).toEqual({ kind: 'invalid-response' });
	});

	it('loads, refreshes, and rejects malformed selected-car responses', async () => {
		gateway.car.value();
		http.expectNone('/api/v1/cars/car%2F1');
		expect(gateway.failure()).toBeNull();
		gateway.selectCar('car/1');
		gateway.selectCar('car/1');
		let read: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			read = http.expectOne('/api/v1/cars/car%2F1');
		});
		expect(read?.request.withCredentials).toBe(true);
		read?.flush({ car: car() });
		await vi.waitFor(() => expect(gateway.car.value()?.id).toBe('car/1'));

		gateway.refresh();
		let refresh: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/cars/car%2F1');
		});
		refresh?.flush({ car: { id: 4 } });
		await vi.waitFor(() => expect(gateway.car.error()).toBeTruthy());
		expect(gateway.failure()).toEqual({ kind: 'invalid-response' });
	});

	it('updates and changes lifecycle through encoded authenticated endpoints', async () => {
		const updated = firstValueFrom(
			gateway.updateCar({ carId: 'car/1', input: { name: 'Blue Buggy' } }),
		);
		const update = http.expectOne('/api/v1/cars/car%2F1');
		expect(update.request.method).toBe('PATCH');
		expect(update.request.withCredentials).toBe(true);
		update.flush({ car: car({ name: 'Blue Buggy' }) });
		await expect(updated).resolves.toMatchObject({ name: 'Blue Buggy' });

		for (const action of ['archive', 'restore'] as const) {
			const changed = firstValueFrom(
				gateway.changeLifecycle({ carId: 'car/1', action }),
			);
			const request = http.expectOne(`/api/v1/cars/car%2F1/${action}`);
			expect(request.request.method).toBe('POST');
			expect(request.request.body).toEqual({});
			request.flush({
				car: car({ archivedAt: action === 'archive' ? '2026-08-09' : null }),
			});
			await expect(changed).resolves.toMatchObject({ id: 'car/1' });
		}
	});

	it('maps update and lifecycle failures before exposing them to stores', async () => {
		const malformed = firstValueFrom(
			gateway.updateCar({ carId: 'car-1', input: { name: 'Bad' } }),
		);
		http.expectOne('/api/v1/cars/car-1').flush({ car: { id: 4 } });
		await expect(malformed).rejects.toEqual({ kind: 'invalid-response' });

		const offline = firstValueFrom(
			gateway.changeLifecycle({ carId: 'car-1', action: 'archive' }),
		);
		http
			.expectOne('/api/v1/cars/car-1/archive')
			.flush('offline', { status: 0, statusText: 'Offline' });
		await expect(offline).rejects.toEqual({ kind: 'unavailable' });
	});
});
