import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceStore } from './maintenance-store';

describe('MaintenanceStore', () => {
	let http: HttpTestingController | undefined;

	const configure = (): InstanceType<typeof MaintenanceStore> => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				MaintenanceStore,
			],
		});
		http = TestBed.inject(HttpTestingController);
		return TestBed.inject(MaintenanceStore);
	};

	const flushReads = async (responses?: {
		plans?: object;
		service?: object;
		consumables?: object;
		timezone?: object;
	}): Promise<void> => {
		await vi.waitFor(() => {
			http
				?.expectOne(
					(request) =>
						request.url === '/api/v1/cars' &&
						request.params.get('archived') === 'all',
				)
				.flush({ cars: [{ id: 'car-1', name: 'Red Runner' }] });
			http
				?.expectOne('/api/v1/preferences/timezone')
				.flush(responses?.timezone ?? { timezone: 'UTC' });
			http
				?.expectOne('/api/v1/maintenance-plans')
				.flush(responses?.plans ?? { maintenancePlans: [], activity: [] });
			http
				?.expectOne('/api/v1/service-records')
				.flush(responses?.service ?? { serviceRecords: [] });
			http
				?.expectOne('/api/v1/consumable-maintenance')
				.flush(responses?.consumables ?? { consumableMaintenance: [] });
			http?.expectOne('/api/v1/consumables/report').flush({ report: {} });
		});
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

	it('normalizes legacy collections and derives activity from service history', async () => {
		const store = configure();
		expect(store.cars()).toEqual([]);
		expect(store.plans()).toEqual([]);
		expect(store.serviceRecords()).toEqual([]);
		expect(store.activity()).toEqual([]);
		expect(store.consumableEntries()).toEqual([]);
		expect(store.report()).toBeNull();
		expect(store.timezone()).toBeTruthy();
		expect(store.loading()).toBe(true);
		expect(store.cockpitLoading()).toBe(true);
		expect(store.consumablesLoading()).toBe(true);
		await flushReads({
			plans: {
				plans: [
					{
						id: 'plan-1',
						carId: 'car-1',
						componentId: null,
						name: 'Inspect',
						status: 'active',
					},
				],
			},
			service: {
				serviceRecords: [
					{
						id: 'record-1',
						carId: 'car-1',
						planId: 'plan-1',
						performedAt: '2026-08-01T00:00:00.000Z',
						description: 'Scheduled work',
					},
					{
						id: 'record-2',
						carId: 'car-1',
						planId: null,
						performedAt: '2026-08-02T00:00:00.000Z',
						description: 'Cleaned car',
					},
					{
						id: 'record-deleted',
						carId: 'car-1',
						performedAt: '2026-08-03T00:00:00.000Z',
						description: 'Removed',
						deletedAt: '2026-08-04T00:00:00.000Z',
					},
				],
			},
			consumables: {},
		});
		await vi.waitFor(() => expect(store.loading()).toBe(false));
		expect(store.cars()[0]?.id).toBe('car-1');
		expect(store.timezone()).toBe('UTC');
		expect(store.plans()[0]?.id).toBe('plan-1');
		expect(store.activity()).toEqual([
			expect.objectContaining({
				action: 'Scheduled service',
				planId: 'plan-1',
			}),
			expect.objectContaining({ action: 'Ad hoc service' }),
		]);
		expect(store.consumableEntries()).toEqual([]);
		expect(store.report()).toEqual({});
		expect(store.cockpitError()).toBe('');
		expect(store.consumablesError()).toBe('');
		expect(store.error()).toBe('');
	});

	it('prefers server activity and supports every reload boundary', async () => {
		const store = configure();
		store.activity();
		await flushReads({
			plans: {
				maintenancePlans: [],
				activity: [
					{
						id: 'activity-1',
						action: 'Server activity',
						occurredAt: '2026-08-01T00:00:00.000Z',
					},
				],
			},
			service: {},
		});
		await vi.waitFor(() =>
			expect(store.activity()[0]?.action).toBe('Server activity'),
		);

		store.retryCockpit();
		await vi.waitFor(() => {
			http
				?.expectOne((request) => request.url === '/api/v1/cars')
				.flush({ cars: [] });
			http?.expectOne('/api/v1/preferences/timezone').flush({});
			http?.expectOne('/api/v1/maintenance-plans').flush({});
			http?.expectOne('/api/v1/service-records').flush({});
		});
		expect(store.plans()).toEqual([]);
		expect(store.serviceRecords()).toEqual([]);

		store.retryConsumables();
		await vi.waitFor(() => {
			http
				?.expectOne((request) => request.url === '/api/v1/cars')
				.flush({ cars: [] });
			http?.expectOne('/api/v1/preferences/timezone').flush({ timezone: '' });
			http?.expectOne('/api/v1/consumable-maintenance').flush({});
			http?.expectOne('/api/v1/consumables/report').flush({ report: {} });
		});

		store.retryAll();
		await flushReads();
		store.refreshPlans();
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/maintenance-plans')
				.flush({ maintenancePlans: [] }),
		);
		store.refreshServiceRecords();
		await vi.waitFor(() =>
			http?.expectOne('/api/v1/service-records').flush({ serviceRecords: [] }),
		);
		store.refreshConsumables();
		await vi.waitFor(() => {
			http
				?.expectOne('/api/v1/consumable-maintenance')
				.flush({ consumableMaintenance: [] });
			http?.expectOne('/api/v1/consumables/report').flush({ report: {} });
		});
	});

	it('separates generic cockpit and consumable errors', async () => {
		const store = configure();
		store.error();
		await vi.waitFor(() => {
			http
				?.expectOne((request) => request.url === '/api/v1/cars')
				.flush({ cars: [] });
			http
				?.expectOne('/api/v1/preferences/timezone')
				.flush({ timezone: 'UTC' });
			http
				?.expectOne('/api/v1/maintenance-plans')
				.flush('offline', { status: 503, statusText: 'Unavailable' });
			http?.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
			http
				?.expectOne('/api/v1/consumable-maintenance')
				.flush('offline', { status: 503, statusText: 'Unavailable' });
			http
				?.expectOne('/api/v1/consumables/report')
				.flush('offline', { status: 503, statusText: 'Unavailable' });
		});
		await vi.waitFor(() => expect(store.loading()).toBe(false));
		expect(store.cockpitError()).toBe(
			'The maintenance ledger could not be loaded.',
		);
		expect(store.consumablesError()).toBe(
			'Consumable history could not be loaded.',
		);
		expect(store.error()).toBe('The maintenance ledger could not be loaded.');
	});

	it('maps a shared unauthorized resource to every protected view', async () => {
		const store = configure();
		store.error();
		await vi.waitFor(() => {
			http
				?.expectOne((request) => request.url === '/api/v1/cars')
				.flush('expired', { status: 401, statusText: 'Unauthorized' });
			http
				?.expectOne('/api/v1/preferences/timezone')
				.flush({ timezone: 'UTC' });
			http
				?.expectOne('/api/v1/maintenance-plans')
				.flush({ maintenancePlans: [] });
			http?.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
			http
				?.expectOne('/api/v1/consumable-maintenance')
				.flush({ consumableMaintenance: [] });
			http?.expectOne('/api/v1/consumables/report').flush({ report: {} });
		});
		await vi.waitFor(() => expect(store.loading()).toBe(false));
		expect(store.cockpitError()).toContain('session has expired');
		expect(store.consumablesError()).toContain('session has expired');
		expect(store.error()).toContain('session has expired');
	});

	it('uses UTC when browser timezone discovery is unavailable', async () => {
		vi.stubGlobal('Intl', {
			DateTimeFormat: class {
				constructor() {
					throw new Error('Intl unavailable');
				}
			},
		});
		const store = configure();
		expect(store.timezone()).toBe('UTC');
		await flushReads({ timezone: {} });
		await vi.waitFor(() => expect(store.loading()).toBe(false));
		expect(store.timezone()).toBe('UTC');
	});

	it('uses UTC when browser timezone discovery is empty or stored data is invalid', async () => {
		const browserIntl = Intl;
		const browserOptions = Intl.DateTimeFormat().resolvedOptions();
		const resolvedOptions = vi
			.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
			.mockReturnValue({
				...browserOptions,
				timeZone: '',
			});
		const store = configure();
		expect(store.timezone()).toBe('UTC');
		resolvedOptions.mockRestore();
		await flushReads({ timezone: { timezone: 'Not/A-Timezone' } });
		await vi.waitFor(() => expect(store.loading()).toBe(false));
		expect(store.timezone()).toBe(
			browserIntl.DateTimeFormat().resolvedOptions().timeZone,
		);
	});
});
