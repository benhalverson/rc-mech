import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CarBuildStore } from './car-build-store';
import { carReadFailure } from './car-read-failure';
import { CarRunsStore, safeTimezone } from './car-runs-store';
import { CarSetupsStore } from './car-setups-store';
import { CarStore } from './car-store';

describe('car route stores', () => {
	let http: HttpTestingController | undefined;

	const configure = (store: unknown): void => {
		TestBed.configureTestingModule({
			providers: [provideHttpClient(), provideHttpClientTesting(), store],
		});
		http = TestBed.inject(HttpTestingController);
	};

	afterEach(() => {
		try {
			http?.verify();
		} finally {
			http = undefined;
			vi.unstubAllGlobals();
			TestBed.resetTestingModule();
		}
	});

	it('groups build history and exposes both reload methods', async () => {
		configure(CarBuildStore);
		const store = TestBed.inject(CarBuildStore);
		expect(store.components()).toEqual([]);
		expect(store.groups()).toEqual([]);

		store.selectCar('car-1');
		store.selectCar('car-1');
		await vi.waitFor(() =>
			http?.expectOne('/api/v1/cars/car-1/components?history=true').flush({
				components: [
					{
						id: 'component-current',
						carId: 'car-1',
						slot: 'motor',
						name: 'Current',
					},
					{
						id: 'component-old',
						carId: 'car-1',
						slot: 'motor',
						name: 'Old',
						installedAt: 'invalid',
						removedAt: '2026-01-01T00:00:00.000Z',
					},
				],
			}),
		);
		expect(store.groups()[0]?.current?.id).toBe('component-current');
		expect(store.groups()[0]?.history).toHaveLength(1);

		store.retry();
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-1/components?history=true')
				.flush({ components: [] }),
		);
		store.refresh();
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-1/components?history=true')
				.flush({ components: [] }),
		);
	});

	it('normalizes run resources, timezones, and reload methods', async () => {
		configure(CarRunsStore);
		const store = TestBed.inject(CarRunsStore);
		expect(store.sessions()).toEqual([]);
		expect(store.timezone()).toBeTruthy();
		expect(safeTimezone('UTC')).toBe('UTC');
		expect(safeTimezone('')).toBe('UTC');
		expect(safeTimezone(null)).toBe('UTC');
		expect(safeTimezone('Not/A-Timezone')).toBe('UTC');

		store.selectCar('car-1');
		store.selectCar('car-1');
		await vi.waitFor(() => {
			http?.expectOne('/api/v1/cars/car-1/drives?history=true').flush({});
			http?.expectOne('/api/v1/preferences/timezone').flush({});
		});
		expect(store.sessions()).toEqual([]);
		expect(store.timezone()).toBe('UTC');

		store.retry();
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-1/drives?history=true')
				.flush({ driveSessions: [] }),
		);
		store.refresh();
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-1/drives?history=true')
				.flush({ driveSessions: [] }),
		);
	});

	it('falls back to UTC when browser timezone discovery throws', async () => {
		configure(CarRunsStore);
		const store = TestBed.inject(CarRunsStore);
		vi.stubGlobal('Intl', {
			DateTimeFormat: class {
				constructor() {
					throw new Error('Intl unavailable');
				}
			},
		});
		expect(store.timezone()).toBe('UTC');
		vi.unstubAllGlobals();
		await vi.waitFor(() =>
			http?.expectOne('/api/v1/preferences/timezone').flush({}),
		);
	});

	it('falls back to UTC when browser timezone discovery returns no timezone', async () => {
		configure(CarRunsStore);
		const store = TestBed.inject(CarRunsStore);
		const realDateTimeFormat = Intl.DateTimeFormat;
		vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((locales, options) => {
			if (options === undefined)
				return {
					resolvedOptions: () => ({ timeZone: '' }),
				} as Intl.DateTimeFormat;
			return new realDateTimeFormat(locales, options);
		});
		expect(store.timezone()).toBe('UTC');
		vi.restoreAllMocks();
		await vi.waitFor(() =>
			http?.expectOne('/api/v1/preferences/timezone').flush({}),
		);
	});

	it('uses setup collection defaults and exposes both reload methods', async () => {
		configure(CarSetupsStore);
		const store = TestBed.inject(CarSetupsStore);
		expect(store.availableCars()).toEqual([]);
		await vi.waitFor(() => http?.expectOne('/api/v1/cars').flush({ cars: [] }));
		store.retry();
		await vi.waitFor(() => http?.expectOne('/api/v1/cars').flush({ cars: [] }));
		store.refresh();
		await vi.waitFor(() => http?.expectOne('/api/v1/cars').flush({ cars: [] }));
	});

	it('ignores stale car mutation and lifecycle responses', async () => {
		configure(CarStore);
		const store = TestBed.inject(CarStore);
		expect(store.car()).toBeNull();
		expect(await store.updateCar({ name: 'No car' })).toBe(false);
		await store.changeArchiveState('archive');

		store.selectCar('car-1');
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-1')
				.flush({ car: { id: 'car-1', name: 'One' } }),
		);
		const update = store.updateCar({ name: 'Updated' });
		expect(await store.updateCar({ name: 'Duplicate' })).toBe(false);
		await store.changeArchiveState('archive');
		const updateRequest = http?.expectOne('/api/v1/cars/car-1');
		store.selectCar('car-2');
		updateRequest?.flush({ car: { id: 'car-1', name: 'Updated' } });
		expect(await update).toBe(false);
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-2')
				.flush({ car: { id: 'car-2', name: 'Two' } }),
		);

		const failedUpdate = store.updateCar({ name: 'Failed' });
		const failure = http?.expectOne('/api/v1/cars/car-2');
		store.selectCar('car-3');
		failure?.flush('offline', { status: 503, statusText: 'Unavailable' });
		expect(await failedUpdate).toBe(false);
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-3')
				.flush({ car: { id: 'car-3', name: 'Three' } }),
		);

		const lifecycle = store.changeArchiveState('archive');
		await store.changeArchiveState('restore');
		const archive = http?.expectOne('/api/v1/cars/car-3/archive');
		store.selectCar('car-4');
		archive?.flush({ status: true });
		await lifecycle;
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-4')
				.flush({ car: { id: 'car-4', name: 'Four' } }),
		);
	});

	it('maps current car mutation failures and non-HTTP read failures', async () => {
		configure(CarStore);
		const store = TestBed.inject(CarStore);
		expect(carReadFailure('offline', 'Fallback read failure.')).toEqual({
			message: 'Fallback read failure.',
			retryable: true,
		});

		store.selectCar('car-1');
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-1')
				.flush({ car: { id: 'car-1', name: 'One' } }),
		);

		const update = store.updateCar({ name: 'Expired' });
		http
			?.expectOne('/api/v1/cars/car-1')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		expect(await update).toBe(false);
		expect(store.carMutationError()).toContain('session has expired');

		const archive = store.changeArchiveState('archive');
		http
			?.expectOne('/api/v1/cars/car-1/archive')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await archive;
		expect(store.lifecycleError()).toContain('could not be archived');
	});
});
