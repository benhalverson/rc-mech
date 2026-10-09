import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OfflineGarageGateway } from './offline-garage-gateway';

describe('OfflineGarageGateway', () => {
	let gateway: OfflineGarageGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				OfflineGarageGateway,
			],
		});
		gateway = TestBed.inject(OfflineGarageGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('loads and parses the complete authenticated Car snapshot', async () => {
		const settings = {
			timezone: 'UTC',
			invites: { allowance: 5, used: 0, remaining: 5, codes: [] },
		};
		const flushSettings = () => {
			http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
			http.expectOne('/api/v1/invite-codes').flush(settings.invites);
		};
		const result = firstValueFrom(gateway.load());
		flushSettings();
		const cars = http.expectOne(
			(candidate) =>
				candidate.url === '/api/v1/cars' &&
				candidate.params.get('archived') === 'all',
		);
		expect(cars.request.withCredentials).toBe(true);
		const setups = http.expectOne('/api/v1/setups');
		expect(setups.request.withCredentials).toBe(true);
		cars.flush({ cars: [{ id: 'car-1', name: 'Track buggy' }] });
		setups.flush({
			setupCollections: [
				{
					carId: 'car-1',
					currentSetupId: 'setup-1',
					currentSetupVersion: 2,
					setups: [
						{
							id: 'setup-1',
							carId: 'car-1',
							name: 'Baseline',
							sections: {},
						},
					],
				},
			],
		});
		await expect(result).resolves.toEqual({
			settings,
			cars: [{ id: 'car-1', name: 'Track buggy' }],
			setupCollections: [
				{
					carId: 'car-1',
					currentSetupId: 'setup-1',
					currentSetupVersion: 2,
					setups: [
						{
							id: 'setup-1',
							carId: 'car-1',
							name: 'Baseline',
							sections: {},
						},
					],
				},
			],
		});

		const malformed = firstValueFrom(gateway.load());
		flushSettings();
		http.expectOne('/api/v1/cars?archived=all').flush({ cars: [{ id: 4 }] });
		http.expectOne('/api/v1/setups').flush({ setupCollections: [] });
		await expect(malformed).rejects.toThrow();

		const empty = firstValueFrom(gateway.load());
		flushSettings();
		http.expectOne('/api/v1/cars?archived=all').flush({ cars: [] });
		http.expectOne('/api/v1/setups').flush({ setupCollections: [] });
		await expect(empty).resolves.toEqual({
			settings,
			cars: [],
			setupCollections: [],
		});

		const malformedSetup = firstValueFrom(gateway.load());
		flushSettings();
		http
			.expectOne('/api/v1/cars?archived=all')
			.flush({ cars: [{ id: 'car-1', name: 'Track buggy' }] });
		http.expectOne('/api/v1/setups').flush({ setupCollections: null });
		await expect(malformedSetup).rejects.toThrow();
	});
});
