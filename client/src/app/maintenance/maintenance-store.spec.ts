import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceGateway } from './maintenance-gateway';
import { MaintenancePlanStore } from './maintenance-plan-store';
import { ServiceRecordStore } from './service-record-store';

const car = { id: 'car-1', name: 'Red Runner' };
const plan = {
	id: 'plan-1',
	carId: 'car-1',
	componentId: null,
	name: 'Inspect',
	status: 'active' as const,
};
const record = {
	id: 'record-1',
	carId: 'car-1',
	planId: 'plan-1',
	performedAt: '2026-08-01T00:00:00.000Z',
	description: 'Scheduled work',
};
const planDraft = (name: string) => ({
	carId: 'car-1',
	name,
	intervalUnit: 'days' as const,
	intervalValue: 7,
	baselineSessionCount: 0,
});
const serviceDraft = (description: string) => ({
	performedAt: '2026-08-09T18:00:00.000Z',
	description,
});
const report = {
	tires: {
		frequency: {
			front: { eventCount: 0, averageIntervalDays: null },
			rear: { eventCount: 0, averageIntervalDays: null },
		},
		spend: {
			front: { total: 0 },
			rear: { total: 0 },
			combined: { total: 0 },
		},
	},
	fluidHistory: [],
};

describe('maintenance workflow stores', () => {
	let http: HttpTestingController;
	let planStore: InstanceType<typeof MaintenancePlanStore>;
	let serviceStore: InstanceType<typeof ServiceRecordStore>;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				MaintenanceGateway,
				MaintenancePlanStore,
				ServiceRecordStore,
			],
		});
		http = TestBed.inject(HttpTestingController);
		planStore = TestBed.inject(MaintenancePlanStore);
		serviceStore = TestBed.inject(ServiceRecordStore);
	});

	afterEach(() => http.verify());

	const flushReads = async (options?: {
		plans?: object;
		services?: object;
		carsStatus?: number;
		servicesStatus?: number;
	}): Promise<void> => {
		await vi.waitFor(() => {
			const cars = http.expectOne(
				(request) =>
					request.url === '/api/v1/cars' &&
					request.params.get('archived') === 'all',
			);
			if (options?.carsStatus)
				cars.flush('failed', {
					status: options.carsStatus,
					statusText: 'Failed',
				});
			else cars.flush({ cars: [car] });
			http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
			http
				.expectOne('/api/v1/maintenance-plans')
				.flush(options?.plans ?? { maintenancePlans: [plan], activity: [] });
			const services = http.expectOne('/api/v1/service-records');
			if (options?.servicesStatus)
				services.flush('failed', {
					status: options.servicesStatus,
					statusText: 'Failed',
				});
			else services.flush(options?.services ?? { serviceRecords: [record] });
			http
				.expectOne('/api/v1/consumable-maintenance')
				.flush({ consumableMaintenance: [] });
			http.expectOne('/api/v1/consumables/report').flush({ report });
		});
	};

	it('normalizes reads and derives activity when the server omits it', async () => {
		expect(planStore.loading()).toBe(true);
		expect(serviceStore.loading()).toBe(true);
		expect(planStore.cars()).toEqual([]);
		expect(planStore.timezone()).toBe('UTC');
		expect(serviceStore.cars()).toEqual([]);
		expect(serviceStore.timezone()).toBe('UTC');
		expect(planStore.plans()).toEqual([]);
		expect(serviceStore.records()).toEqual([]);
		expect(serviceStore.activity()).toEqual([]);
		expect(planStore.action()).toBeNull();
		expect(serviceStore.action()).toBeNull();
		await flushReads({
			plans: { plans: [plan] },
			services: {
				serviceRecords: [
					record,
					{ ...record, id: 'record-2', planId: null },
					{ ...record, id: 'deleted', deletedAt: '2026-08-02' },
				],
			},
		});
		await vi.waitFor(() => expect(planStore.loading()).toBe(false));
		expect(serviceStore.loading()).toBe(false);
		expect(planStore.cars()).toEqual([car]);
		expect(planStore.plans()).toEqual([plan]);
		expect(planStore.timezone()).toBe('UTC');
		expect(serviceStore.cars()).toEqual([car]);
		expect(serviceStore.timezone()).toBe('UTC');
		expect(serviceStore.activity().map((item) => item.action)).toEqual([
			'Scheduled service',
			'Ad hoc service',
		]);
		expect(planStore.error()).toBe('');
		expect(serviceStore.error()).toBe('');
	});

	it('reports loading only while each read has no usable value', async () => {
		let cars!: TestRequest;
		let timezone!: TestRequest;
		let plans!: TestRequest;
		let services!: TestRequest;
		let consumables!: TestRequest;
		let reportRequest!: TestRequest;
		await vi.waitFor(() => {
			cars = http.expectOne(
				(request) =>
					request.url === '/api/v1/cars' &&
					request.params.get('archived') === 'all',
			);
			timezone = http.expectOne('/api/v1/preferences/timezone');
			plans = http.expectOne('/api/v1/maintenance-plans');
			services = http.expectOne('/api/v1/service-records');
			consumables = http.expectOne('/api/v1/consumable-maintenance');
			reportRequest = http.expectOne('/api/v1/consumables/report');
		});
		cars.flush({ cars: [car] });
		expect(planStore.loading()).toBe(true);
		timezone.flush({ timezone: 'UTC' });
		expect(planStore.loading()).toBe(true);
		plans.flush({ maintenancePlans: [plan], activity: [] });
		await vi.waitFor(() => expect(planStore.loading()).toBe(false));
		services.flush({ serviceRecords: [record] });
		consumables.flush({ consumableMaintenance: [] });
		reportRequest.flush({ report });

		planStore.refresh();
		let refreshedPlans!: TestRequest;
		await vi.waitFor(() => {
			const matches = http.match('/api/v1/maintenance-plans');
			expect(matches).toHaveLength(1);
			[refreshedPlans] = matches;
		});
		expect(planStore.loading()).toBe(false);
		refreshedPlans.flush({ plans: [plan] });
		serviceStore.refresh();
		let refreshedServices!: TestRequest;
		await vi.waitFor(() => {
			const matches = http.match('/api/v1/service-records');
			expect(matches).toHaveLength(1);
			[refreshedServices] = matches;
		});
		expect(serviceStore.loading()).toBe(false);
		refreshedServices.flush({ serviceRecords: [record] });

		planStore.retry();
		let retriedCars!: TestRequest;
		let retriedTimezone!: TestRequest;
		let retriedPlans!: TestRequest;
		await vi.waitFor(() => {
			[retriedCars] = http.match((request) => request.url === '/api/v1/cars');
			[retriedTimezone] = http.match('/api/v1/preferences/timezone');
			[retriedPlans] = http.match('/api/v1/maintenance-plans');
			expect(retriedCars).toBeTruthy();
			expect(retriedTimezone).toBeTruthy();
			expect(retriedPlans).toBeTruthy();
		});
		expect(planStore.loading()).toBe(false);
		retriedCars.flush({ cars: [car] });
		retriedTimezone.flush({ timezone: 'UTC' });
		retriedPlans.flush({ plans: [plan] });
	});

	it('prefers server activity and maps protected read failures', async () => {
		await flushReads({
			plans: {
				maintenancePlans: [],
				activity: [
					{
						id: 'activity-1',
						action: 'Server activity',
						occurredAt: '2026-08-01',
					},
				],
			},
			carsStatus: 401,
		});
		await vi.waitFor(() => expect(planStore.loading()).toBe(false));
		expect(serviceStore.activity()[0]?.action).toBe('Server activity');
		expect(planStore.error()).toContain('session has expired');
	});

	it('maps a generic read failure when the session is still active', async () => {
		await flushReads({ carsStatus: 503 });
		await vi.waitFor(() => expect(planStore.loading()).toBe(false));
		expect(planStore.error()).toContain('could not be loaded');
	});

	it('maps protected and generic service-record read failures', async () => {
		await flushReads({ servicesStatus: 401 });
		await vi.waitFor(() => expect(serviceStore.loading()).toBe(false));
		expect(serviceStore.error()).toContain('session has expired');

		serviceStore.retry();
		await vi.waitFor(() =>
			http
				.expectOne('/api/v1/service-records')
				.flush('offline', { status: 503, statusText: 'Unavailable' }),
		);
		expect(serviceStore.error()).toContain('could not be loaded');
	});

	it('retries and refreshes each cockpit read boundary', async () => {
		await flushReads();
		planStore.retry();
		serviceStore.retry();
		await vi.waitFor(() => {
			http
				.expectOne((request) => request.url === '/api/v1/cars')
				.flush({ cars: [] });
			http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
			http.expectOne('/api/v1/maintenance-plans').flush({ plans: [] });
			http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
		});
		planStore.refresh();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/maintenance-plans').flush({ plans: [] }),
		);
		serviceStore.refresh();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] }),
		);
	});

	it('serializes plan commands and publishes success and failure outcomes', async () => {
		await flushReads();
		planStore.mutate({
			kind: 'save-plan',
			mode: 'create',
			id: null,
			plan: planDraft('Bearings'),
		});
		planStore.mutate({
			kind: 'save-plan',
			mode: 'create',
			id: null,
			plan: planDraft('Ignored'),
		});
		expect(planStore.action()).toBe('create');
		expect(serviceStore.action()).toBeNull();
		const create = http.expectOne('/api/v1/maintenance-plans');
		expect(create.request.body).toEqual(planDraft('Bearings'));
		create.flush({ maintenancePlan: plan });
		await vi.waitFor(() =>
			http.expectOne('/api/v1/maintenance-plans').flush({ plans: [plan] }),
		);
		expect(planStore.outcome().status).toBe('succeeded');

		planStore.mutate({
			kind: 'save-plan',
			mode: 'edit',
			id: 'plan/1',
			plan: planDraft('Updated'),
		});
		http
			.expectOne('/api/v1/maintenance-plans/plan%2F1')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		expect(planStore.outcome().status).toBe('failed');
		planStore.clearOutcome();
		expect(planStore.outcome().status).toBe('idle');
	});

	it('runs transition and service commands through their gateway contracts', async () => {
		await flushReads();
		planStore.mutate({
			kind: 'transition-plan',
			planId: 'plan/1',
			action: 'pause',
		});
		expect(planStore.action()).toBe('pause:plan/1');
		expect(serviceStore.action()).toBeNull();
		http
			.expectOne('/api/v1/maintenance-plans/plan%2F1/pause')
			.flush({ maintenancePlan: plan });
		await vi.waitFor(() =>
			http.expectOne('/api/v1/maintenance-plans').flush({ plans: [plan] }),
		);

		for (const command of [
			{
				kind: 'save-service' as const,
				mode: 'create' as const,
				carId: 'car/1',
				id: null,
				service: serviceDraft('Cleaned'),
			},
			{
				kind: 'save-service' as const,
				mode: 'edit' as const,
				carId: 'car/1',
				id: 'record/1',
				service: serviceDraft('Updated'),
			},
			{
				kind: 'save-service' as const,
				mode: 'complete' as const,
				carId: 'car/1',
				id: 'plan/1',
				service: serviceDraft('Complete'),
			},
		]) {
			serviceStore.mutate(command);
			expect(planStore.action()).toBeNull();
			expect(serviceStore.action()).toBe(command.mode);
			const request = http.expectOne((candidate) =>
				candidate.url.includes(
					command.mode === 'create'
						? '/cars/car%2F1/service-records'
						: command.mode === 'edit'
							? '/service-records/record%2F1'
							: '/maintenance-plans/plan%2F1/complete',
				),
			);
			request.flush({ serviceRecord: record });
			await vi.waitFor(() => {
				http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
				http.expectOne('/api/v1/maintenance-plans').flush({ plans: [] });
			});
		}

		for (const [kind, action, path] of [
			['change-service', 'archive', '/api/v1/service-records/record%2F1'],
			[
				'change-service',
				'restore',
				'/api/v1/service-records/record%2F1/restore',
			],
			['undo-activity', '', '/api/v1/service-records/record%2F1'],
		] as const) {
			serviceStore.mutate(
				kind === 'change-service'
					? { kind, recordId: 'record/1', action }
					: { kind, recordId: 'record/1' },
			);
			expect(planStore.action()).toBeNull();
			expect(serviceStore.action()).toBe(
				kind === 'change-service'
					? `${action === 'archive' ? 'delete' : 'restore'}:record/1`
					: null,
			);
			http.expectOne(path).flush({ serviceRecord: record });
			await vi.waitFor(() => {
				http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
				http.expectOne('/api/v1/maintenance-plans').flush({ plans: [] });
			});
		}

		serviceStore.mutate({
			kind: 'save-service',
			mode: 'create',
			carId: 'car-1',
			id: null,
			service: serviceDraft('Fails'),
		});
		serviceStore.mutate({
			kind: 'save-service',
			mode: 'create',
			carId: 'car-1',
			id: null,
			service: serviceDraft('Ignored while pending'),
		});
		http
			.expectOne('/api/v1/cars/car-1/service-records')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		expect(serviceStore.outcome().status).toBe('failed');
	});

	it('normalizes mutation transport failures into workflow reasons', async () => {
		await flushReads();
		planStore.mutate({
			kind: 'transition-plan',
			planId: 'plan-1',
			action: 'archive',
		});
		http
			.expectOne('/api/v1/maintenance-plans/plan-1/archive')
			.flush('failed', { status: 500, statusText: 'Failed' });
		expect(planStore.outcome()).toMatchObject({
			status: 'failed',
			failure: 'transition-failed',
		});

		for (const [status, failure] of [
			[401, 'session-expired'],
			[409, 'car-archived'],
			[500, 'save-failed'],
		] as const) {
			planStore.mutate({
				kind: 'save-plan',
				mode: 'create',
				id: null,
				plan: planDraft('Failure'),
			});
			http
				.expectOne('/api/v1/maintenance-plans')
				.flush('failed', { status, statusText: 'Failed' });
			expect(planStore.outcome()).toMatchObject({ status: 'failed', failure });
		}

		for (const [command, path, failure] of [
			[
				{ kind: 'undo-activity' as const, recordId: 'record-1' },
				'/api/v1/service-records/record-1',
				'undo-failed',
			],
			[
				{
					kind: 'change-service' as const,
					recordId: 'record-1',
					action: 'archive' as const,
				},
				'/api/v1/service-records/record-1',
				'archive-failed',
			],
			[
				{
					kind: 'change-service' as const,
					recordId: 'record-1',
					action: 'restore' as const,
				},
				'/api/v1/service-records/record-1/restore',
				'restore-failed',
			],
		] as const) {
			serviceStore.mutate(command);
			http
				.expectOne(path)
				.flush('failed', { status: 500, statusText: 'Failed' });
			expect(serviceStore.outcome()).toMatchObject({
				status: 'failed',
				failure,
			});
		}

		for (const [status, failure] of [
			[401, 'session-expired'],
			[409, 'car-archived'],
			[500, 'save-failed'],
		] as const) {
			serviceStore.mutate({
				kind: 'save-service',
				mode: 'create',
				carId: 'car-1',
				id: null,
				service: serviceDraft('Failure'),
			});
			http
				.expectOne('/api/v1/cars/car-1/service-records')
				.flush('failed', { status, statusText: 'Failed' });
			expect(serviceStore.outcome()).toMatchObject({
				status: 'failed',
				failure,
			});
		}
	});

	it('loads only the latest car component lookup and clears failures', async () => {
		await flushReads();
		planStore.loadComponents('car-1');
		const first = http.expectOne('/api/v1/cars/car-1/components');
		planStore.loadComponents('car-2');
		http.expectOne('/api/v1/cars/car-2/components').flush({
			components: [
				{ id: 'component-2', carId: 'car-2', slot: 'motor', name: 'Motor' },
			],
		});
		expect(first.cancelled).toBe(true);
		expect(planStore.components()[0]?.id).toBe('component-2');
		planStore.loadComponents('');
		expect(planStore.components()).toEqual([]);
		planStore.loadComponents('car-3');
		http
			.expectOne('/api/v1/cars/car-3/components')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		expect(planStore.components()).toEqual([]);
	});

	it('owns service component lookups and outcome reset independently', async () => {
		await flushReads();
		serviceStore.loadComponents('car-1');
		const first = http.expectOne('/api/v1/cars/car-1/components');
		serviceStore.loadComponents('car-2');
		http.expectOne('/api/v1/cars/car-2/components').flush({
			components: [
				{ id: 'component-2', carId: 'car-2', slot: 'motor', name: 'Motor' },
			],
		});
		expect(first.cancelled).toBe(true);
		expect(serviceStore.components()[0]?.id).toBe('component-2');

		serviceStore.loadComponents('');
		expect(serviceStore.components()).toEqual([]);
		serviceStore.loadComponents('car-3');
		http
			.expectOne('/api/v1/cars/car-3/components')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		expect(serviceStore.components()).toEqual([]);
		serviceStore.clearOutcome();
		expect(serviceStore.outcome()).toEqual({
			status: 'idle',
			operationId: null,
		});
	});
});
