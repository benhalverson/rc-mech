import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	MaintenanceGateway,
	maintenanceGatewayFailure,
	parseMaintenanceTimezone,
	resolveMaintenanceBrowserTimezone,
} from './maintenance-gateway';

const plan = {
	id: 'plan-1',
	carId: 'car-1',
	name: 'Inspect bearings',
	status: 'active' as const,
};
const planDraft = {
	carId: 'car-1',
	name: 'Inspect bearings',
	intervalUnit: 'days' as const,
	intervalValue: 7,
	baselineSessionCount: 0,
};
const service = {
	id: 'record-1',
	carId: 'car-1',
	performedAt: '2026-08-09T18:00:00.000Z',
	description: 'Serviced bearings',
};
const serviceDraft = {
	performedAt: service.performedAt,
	description: service.description,
};
const consumable = {
	id: 'entry-1',
	carId: 'car-1',
	kind: 'shock-fluid' as const,
	performedAt: '2026-08-09T18:00:00.000Z',
	fluidArea: 'front-shocks' as const,
};
const consumableDraft = {
	kind: 'shock-fluid' as const,
	performedAt: consumable.performedAt,
	fluidArea: 'front-shocks' as const,
};

describe('MaintenanceGateway', () => {
	let gateway: MaintenanceGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				MaintenanceGateway,
			],
		});
		gateway = TestBed.inject(MaintenanceGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		try {
			for (const request of http.match(
				(candidate) =>
					candidate.method === 'GET' &&
					[
						'/api/v1/cars',
						'/api/v1/preferences/timezone',
						'/api/v1/maintenance-plans',
						'/api/v1/service-records',
						'/api/v1/consumable-maintenance',
						'/api/v1/consumables/report',
					].includes(candidate.url),
			)) {
				const responses: Record<string, object> = {
					'/api/v1/cars': { cars: [] },
					'/api/v1/preferences/timezone': { timezone: 'UTC' },
					'/api/v1/maintenance-plans': {
						maintenancePlans: [],
						activity: [],
					},
					'/api/v1/service-records': { serviceRecords: [] },
					'/api/v1/consumable-maintenance': {
						consumableMaintenance: [],
					},
					'/api/v1/consumables/report': {
						report: { tires: {} },
					},
				};
				request.flush(responses[request.request.url]);
			}
			http.verify();
		} finally {
			vi.unstubAllGlobals();
			TestBed.resetTestingModule();
		}
	});

	const resourceRequest = async (
		read: () => unknown,
		url: string,
	): Promise<ReturnType<HttpTestingController['expectOne']>> => {
		read();
		let request: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			request = http.expectOne((candidate) => candidate.url === url);
		});
		if (!request)
			throw new Error(`Resource request was not issued for ${url}.`);
		return request;
	};

	it('maps HTTP, invalid-response, unavailable, and empty failures', async () => {
		expect(gateway.failure(null)).toBeNull();
		expect(
			maintenanceGatewayFailure(new HttpErrorResponse({ status: 0 })),
		).toEqual({ kind: 'unavailable' });
		expect(
			maintenanceGatewayFailure(new HttpErrorResponse({ status: 401 })),
		).toEqual({ kind: 'http', status: 401 });
		expect(maintenanceGatewayFailure('offline')).toEqual({
			kind: 'unavailable',
		});

		const request = await resourceRequest(
			() => gateway.cars.value(),
			'/api/v1/cars',
		);
		request.flush({ cars: [null] });
		await vi.waitFor(() => expect(gateway.cars.error()).toBeTruthy());
		expect(gateway.failure(gateway.cars.error())).toEqual({
			kind: 'invalid-response',
		});
	});

	it('normalizes invalid timezone values through browser and UTC fallbacks', async () => {
		expect(parseMaintenanceTimezone({ timezone: 'UTC' })).toBe('UTC');
		const request = await resourceRequest(
			() => gateway.timezone.value(),
			'/api/v1/preferences/timezone',
		);
		request.flush({ timezone: '' });
		await vi.waitFor(() => expect(gateway.timezone.value()).toBeTruthy());

		expect(resolveMaintenanceBrowserTimezone(() => 'America/Los_Angeles')).toBe(
			'America/Los_Angeles',
		);
		expect(resolveMaintenanceBrowserTimezone(() => '')).toBe('UTC');
		expect(resolveMaintenanceBrowserTimezone(() => 'Invalid/Timezone')).toBe(
			'UTC',
		);
		expect(
			resolveMaintenanceBrowserTimezone(() => {
				throw new Error('Intl unavailable');
			}),
		).toBe('UTC');
	});

	it('accepts compatibility collections and rejects malformed plan activity', async () => {
		let request = await resourceRequest(
			() => gateway.plans.value(),
			'/api/v1/maintenance-plans',
		);
		request.flush({});
		await vi.waitFor(() =>
			expect(gateway.plans.value()).toEqual({ plans: [], activity: [] }),
		);

		gateway.plans.reload();
		request = await resourceRequest(
			() => gateway.plans.value(),
			'/api/v1/maintenance-plans',
		);
		request.flush({ plans: [plan] });
		await vi.waitFor(() =>
			expect(gateway.plans.value()?.plans).toEqual([plan]),
		);

		gateway.plans.reload();
		request = await resourceRequest(
			() => gateway.plans.value(),
			'/api/v1/maintenance-plans',
		);
		request.flush({ maintenancePlans: [{ id: 4 }], activity: [null] });
		await vi.waitFor(() => expect(gateway.plans.error()).toBeTruthy());
	});

	it('normalizes omitted service and consumable arrays', async () => {
		const services = await resourceRequest(
			() => gateway.services.value(),
			'/api/v1/service-records',
		);
		services.flush({});
		const consumables = await resourceRequest(
			() => gateway.consumables.value(),
			'/api/v1/consumable-maintenance',
		);
		consumables.flush({});
		await vi.waitFor(() => {
			expect(gateway.services.value()).toEqual([]);
			expect(gateway.consumables.value()).toEqual([]);
		});
	});

	it('normalizes every current-tire compatibility response', async () => {
		for (const [response, expected] of [
			[{ setup: { tires: { front: 'Direct' } } }, { front: 'Direct' }],
			[
				{
					setups: [
						{ current: false, tires: { front: 'Old' } },
						{ current: true, tires: { front: 'Current' } },
					],
				},
				{ front: 'Current' },
			],
			[
				{ setups: [{ current: false, tires: { front: 'First' } }] },
				{ front: 'First' },
			],
			[{}, null],
		] as const) {
			const tires = firstValueFrom(gateway.currentTires('car/1'));
			const request = http.expectOne('/api/v1/cars/car%2F1/setups/current');
			expect(request.request.withCredentials).toBe(true);
			request.flush(response);
			await expect(tires).resolves.toEqual(expected);
		}
	});

	it('sends plan mutations to their credentialed endpoints', async () => {
		let result = firstValueFrom(gateway.savePlan('create', null, planDraft));
		let request = http.expectOne(
			(candidate) =>
				candidate.method === 'POST' &&
				candidate.url === '/api/v1/maintenance-plans',
		);
		expect(request.request.body).toEqual(planDraft);
		expect(request.request.withCredentials).toBe(true);
		request.flush({ maintenancePlan: plan });
		await expect(result).resolves.toEqual(plan);

		result = firstValueFrom(gateway.savePlan('edit', 'plan/1', planDraft));
		request = http.expectOne({
			method: 'PATCH',
			url: '/api/v1/maintenance-plans/plan%2F1',
		});
		expect(request.request.body).toEqual(planDraft);
		expect(request.request.withCredentials).toBe(true);
		request.flush({ maintenancePlan: plan });
		await expect(result).resolves.toEqual(plan);

		result = firstValueFrom(gateway.transitionPlan('plan/1', 'pause'));
		request = http.expectOne({
			method: 'POST',
			url: '/api/v1/maintenance-plans/plan%2F1/pause',
		});
		expect(request.request.body).toEqual({});
		expect(request.request.withCredentials).toBe(true);
		request.flush({ maintenancePlan: plan });
		await expect(result).resolves.toEqual(plan);
	});

	it('sends service mutations to their credentialed endpoints', async () => {
		let result = firstValueFrom(
			gateway.saveService('create', 'car/1', null, serviceDraft),
		);
		let request = http.expectOne({
			method: 'POST',
			url: '/api/v1/cars/car%2F1/service-records',
		});
		expect(request.request.body).toEqual(serviceDraft);
		expect(request.request.withCredentials).toBe(true);
		request.flush({ serviceRecord: service });
		await expect(result).resolves.toEqual(service);

		result = firstValueFrom(
			gateway.saveService('edit', 'car-1', 'record/1', serviceDraft),
		);
		request = http.expectOne({
			method: 'PATCH',
			url: '/api/v1/service-records/record%2F1',
		});
		expect(request.request.body).toEqual(serviceDraft);
		expect(request.request.withCredentials).toBe(true);
		request.flush({ serviceRecord: service });
		await expect(result).resolves.toEqual(service);

		result = firstValueFrom(
			gateway.saveService('complete', 'car-1', 'plan/1', serviceDraft),
		);
		request = http.expectOne({
			method: 'POST',
			url: '/api/v1/maintenance-plans/plan%2F1/complete',
		});
		expect(request.request.body).toEqual(serviceDraft);
		expect(request.request.withCredentials).toBe(true);
		request.flush({ serviceRecord: service });
		await expect(result).resolves.toEqual(service);

		result = firstValueFrom(gateway.changeService('record/1', 'archive'));
		request = http.expectOne({
			method: 'DELETE',
			url: '/api/v1/service-records/record%2F1',
		});
		expect(request.request.withCredentials).toBe(true);
		request.flush({ serviceRecord: service });
		await expect(result).resolves.toEqual(service);

		result = firstValueFrom(gateway.changeService('record/1', 'restore'));
		request = http.expectOne({
			method: 'POST',
			url: '/api/v1/service-records/record%2F1/restore',
		});
		expect(request.request.body).toEqual({});
		expect(request.request.withCredentials).toBe(true);
		request.flush({ serviceRecord: service });
		await expect(result).resolves.toEqual(service);
	});

	it('sends consumable mutations to their credentialed car endpoints', async () => {
		let result = firstValueFrom(
			gateway.saveConsumable('create', 'car/1', null, consumableDraft),
		);
		let request = http.expectOne({
			method: 'POST',
			url: '/api/v1/cars/car%2F1/consumable-maintenance',
		});
		expect(request.request.body).toEqual(consumableDraft);
		expect(request.request.withCredentials).toBe(true);
		request.flush({ consumableMaintenance: consumable });
		await expect(result).resolves.toEqual(consumable);

		result = firstValueFrom(
			gateway.saveConsumable('edit', 'car/1', 'entry/1', consumableDraft),
		);
		request = http.expectOne({
			method: 'PATCH',
			url: '/api/v1/cars/car%2F1/consumable-maintenance/entry%2F1',
		});
		expect(request.request.body).toEqual(consumableDraft);
		expect(request.request.withCredentials).toBe(true);
		request.flush({ consumableMaintenance: consumable });
		await expect(result).resolves.toEqual(consumable);

		result = firstValueFrom(gateway.changeConsumable(consumable, 'archive'));
		request = http.expectOne({
			method: 'DELETE',
			url: '/api/v1/cars/car-1/consumable-maintenance/entry-1',
		});
		expect(request.request.withCredentials).toBe(true);
		request.flush({ consumableMaintenance: consumable });
		await expect(result).resolves.toEqual(consumable);

		result = firstValueFrom(gateway.changeConsumable(consumable, 'restore'));
		request = http.expectOne({
			method: 'POST',
			url: '/api/v1/cars/car-1/consumable-maintenance/entry-1/restore',
		});
		expect(request.request.body).toEqual({});
		expect(request.request.withCredentials).toBe(true);
		request.flush({ consumableMaintenance: consumable });
		await expect(result).resolves.toEqual(consumable);
	});

	it('maps malformed mutations and component lookups canonically', async () => {
		const malformedPlan = firstValueFrom(
			gateway.savePlan('create', null, planDraft),
		);
		http
			.expectOne('/api/v1/maintenance-plans')
			.flush({ maintenancePlan: { id: 4 } });
		await expect(malformedPlan).rejects.toEqual({ kind: 'invalid-response' });

		const malformedConsumable = firstValueFrom(
			gateway.saveConsumable('create', 'car-1', null, consumableDraft),
		);
		http
			.expectOne('/api/v1/cars/car-1/consumable-maintenance')
			.flush({ consumableMaintenance: { id: 4 } });
		await expect(malformedConsumable).rejects.toEqual({
			kind: 'invalid-response',
		});

		const components = firstValueFrom(gateway.components('car/1'));
		http.expectOne('/api/v1/cars/car%2F1/components').flush({
			components: [
				{
					id: 'component-1',
					carId: 'car/1',
					slot: 'motor',
					name: 'Installed',
				},
				{
					id: 'component-old',
					carId: 'car/1',
					slot: 'motor',
					name: 'Removed',
					removedAt: '2026-08-01',
				},
			],
		});
		await expect(components).resolves.toEqual([
			expect.objectContaining({ id: 'component-1' }),
		]);

		const malformedComponents = firstValueFrom(gateway.components('car-1'));
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush({ components: [null] });
		await expect(malformedComponents).rejects.toEqual({
			kind: 'invalid-response',
		});
	});
});
