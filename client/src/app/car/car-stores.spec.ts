import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GarageGateway } from '../garage/garage-gateway';
import { CarBuildGateway } from './car-build-gateway';
import { CarBuildStore } from './car-build-store';
import { CarGateway } from './car-gateway';
import { carReadFailure } from './car-read-failure';
import { CarStore } from './car-store';
import { CarSetupsStore } from './setups/car-setups-store';

describe('car route stores', () => {
	let http: HttpTestingController | undefined;

	const configure = (store: unknown): void => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				CarBuildGateway,
				CarGateway,
				GarageGateway,
				store,
			],
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

	it('guards build saves and ignores stale success after route reuse', async () => {
		configure(CarBuildStore);
		const store = TestBed.inject(CarBuildStore);
		const save = {
			mode: 'add' as const,
			componentId: null,
			input: { slot: 'motor', name: 'Race motor' },
		};
		store.save(save);
		http?.expectNone((request) => request.method === 'POST');

		store.selectCar('car-1');
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-1/components?history=true')
				.flush({ components: [] }),
		);
		store.save(save);
		store.save(save);
		const pending = http?.expectOne('/api/v1/cars/car-1/components');
		store.selectCar('car-2');
		pending?.flush({
			component: {
				id: 'component-1',
				carId: 'car-1',
				slot: 'motor',
				name: 'Race motor',
			},
		});
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-2/components?history=true')
				.flush({ components: [] }),
		);
		expect(store.outcome().status).toBe('idle');
	});

	it('uses setup collection defaults and exposes both reload methods', async () => {
		configure(CarSetupsStore);
		const store = TestBed.inject(CarSetupsStore);
		expect(store.availableCars()).toEqual([]);
		store.createCar({
			sourceCarId: 'another-car',
			input: { name: 'Ignored import car' },
		});
		http?.expectNone((request) => request.method === 'POST');
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
		store.updateCar({ name: 'No car' });
		store.changeArchiveState('archive');

		store.selectCar('car-1');
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-1')
				.flush({ car: { id: 'car-1', name: 'One' } }),
		);
		store.updateCar({ name: 'Updated' });
		store.updateCar({ name: 'Duplicate' });
		store.changeArchiveState('archive');
		const updateRequest = http?.expectOne('/api/v1/cars/car-1');
		store.selectCar('car-2');
		updateRequest?.flush({ car: { id: 'car-1', name: 'Updated' } });
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-2')
				.flush({ car: { id: 'car-2', name: 'Two' } }),
		);

		store.updateCar({ name: 'Failed' });
		const failure = http?.expectOne('/api/v1/cars/car-2');
		store.selectCar('car-3');
		failure?.flush('offline', { status: 503, statusText: 'Unavailable' });
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-3')
				.flush({ car: { id: 'car-3', name: 'Three' } }),
		);

		store.changeArchiveState('archive');
		store.changeArchiveState('restore');
		const archive = http?.expectOne('/api/v1/cars/car-3/archive');
		store.selectCar('car-4');
		archive?.flush({ car: { id: 'car-3', name: 'Three', archivedAt: 'now' } });
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

		store.updateCar({ name: 'Expired' });
		http
			?.expectOne('/api/v1/cars/car-1')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		expect(store.carMutationError()).toContain('session has expired');

		store.changeArchiveState('archive');
		http
			?.expectOne('/api/v1/cars/car-1/archive')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		expect(store.lifecycleError()).toContain('could not be archived');

		store.retry();
		await vi.waitFor(() =>
			http?.expectOne('/api/v1/cars/car-1').flush({ car: { id: 4 } }),
		);
		await vi.waitFor(() =>
			expect(store.failure()?.message).toContain('could not be loaded'),
		);
	});
});
