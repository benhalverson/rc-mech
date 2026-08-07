import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { MaintenanceStore } from './maintenance/maintenance-store';
import {
	calculatePlanState,
	calendarDays,
	MaintenanceCockpit,
	MaintenancePlan,
	ServiceRecord,
} from './maintenance-cockpit';

type TestMember = {
	set(value: unknown): void;
	update<U>(updater: (value: U) => U): void;
};
type TestSignal<T> = TestMember & (() => T);
type MaintenanceTestHarness = {
	openCreate: (...args: unknown[]) => unknown;
	form: TestSignal<Record<string, string>>;
	save: (...args: unknown[]) => unknown;
	openServiceCreate: (...args: unknown[]) => unknown;
	serviceForm: TestSignal<Record<string, string>>;
	saveService: (...args: unknown[]) => unknown;
	openCompletion: (...args: unknown[]) => unknown;
	serviceRecords: TestSignal<ServiceRecord[]>;
	plans: TestSignal<MaintenancePlan[]>;
	deleteService: (...args: unknown[]) => unknown;
	restoreService: (...args: unknown[]) => unknown;
	transition: (
		plan: MaintenancePlan,
		action: 'pause' | 'resume' | 'archive',
	) => void;
	garage: TestSignal<unknown[]>;
};

describe('MaintenanceCockpit', () => {
	let fixture: ComponentFixture<MaintenanceCockpit>;
	let http: HttpTestingController;
	const car = { id: 'car-1', name: 'Red Runner', archivedAt: null };
	const component = {
		id: 'component-1',
		carId: 'car-1',
		slot: 'motor',
		name: 'Race motor',
	};
	const plan: MaintenancePlan = {
		id: 'plan-1',
		carId: 'car-1',
		componentId: 'component-1',
		name: 'Clean bearings',
		intervalDays: 30,
		intervalSessions: 5,
		baselineAt: '2026-07-01T00:00:00.000Z',
		baselineSessionCount: 0,
		status: 'active',
	};

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [MaintenanceCockpit],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				MaintenanceStore,
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(MaintenanceCockpit);
		fixture.detectChanges();
		http
			.expectOne(
				(request) =>
					request.url === '/api/v1/cars' &&
					request.params.get('archived') === 'all',
			)
			.flush({ cars: [car] });
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/maintenance-plans')
			.flush({ maintenancePlans: [plan], activity: [] });
		http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
		http
			.expectOne('/api/v1/consumable-maintenance')
			.flush({ consumableMaintenance: [] });
		http.expectOne('/api/v1/consumables/report').flush({ report: {} });
		fixture.detectChanges();
	});

	afterEach(() => http.verify());

	it('groups date, run, combined, timezone, and lifecycle states', () => {
		expect(calendarDays(2, 'weeks')).toBe(14);
		expect(calendarDays(1, 'months')).toBe(30);
		expect(
			calculatePlanState(
				{ ...plan, intervalSessions: null },
				new Date('2026-07-15T00:00:00.000Z'),
			),
		).toBe('upcoming');
		expect(
			calculatePlanState(
				{ ...plan, intervalDays: null },
				new Date('2026-07-02T00:00:00.000Z'),
				5,
			),
		).toBe('due');
		expect(calculatePlanState(plan, new Date('2026-08-02T00:00:00.000Z'))).toBe(
			'overdue',
		);
		expect(calculatePlanState({ ...plan, status: 'paused' })).toBe('paused');
		expect(calculatePlanState({ ...plan, status: 'archived' })).toBe(
			'archived',
		);
		expect(
			fixture.nativeElement.querySelector(
				'#maintenance-title[data-route-focus][tabindex="-1"]',
			),
		).toBeTruthy();
	});

	it('clears a plan mutation failure when the owner retries', async () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.transition(plan, 'pause');
		http
			.expectOne('/api/v1/maintenance-plans/plan-1/pause')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain(
			'That maintenance update could not be saved.',
		);
		expect(fixture.nativeElement.textContent).toContain('Clean bearings');

		app.transition(plan, 'pause');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).not.toContain(
			'That maintenance update could not be saved.',
		);
		http
			.expectOne('/api/v1/maintenance-plans/plan-1/pause')
			.flush({ maintenancePlan: { ...plan, status: 'paused' } });
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/maintenance-plans');
		});
		refresh?.flush({
			maintenancePlans: [{ ...plan, status: 'paused' }],
			activity: [],
		});
	});

	it('keeps cockpit data visible when only the consumable report fails', async () => {
		const store = TestBed.inject(MaintenanceStore);
		store.reportResource.reload();
		let report: TestRequest | undefined;
		await vi.waitFor(() => {
			report = http.expectOne('/api/v1/consumables/report');
		});
		report?.flush('offline', { status: 503, statusText: 'Unavailable' });
		await fixture.whenStable();
		fixture.detectChanges();

		expect(
			fixture.nativeElement.querySelector(
				'.maintenance-cockpit > .state-card.error-state',
			),
		).toBeNull();
		expect(fixture.nativeElement.textContent).toContain('Clean bearings');
	});

	it('creates a plan through the existing relative maintenance endpoint', async () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.openCreate();
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush({ components: [component] });
		app.form.set({
			carId: 'car-1',
			componentId: 'component-1',
			name: 'Clean bearings',
			calendarValue: '2',
			calendarUnit: 'weeks',
			runInterval: '5',
			baselineAt: '2026-08-01T10:00',
			baselineRuns: '3',
		});
		app.save();
		const request = http.expectOne('/api/v1/maintenance-plans');
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toMatchObject({
			carId: 'car-1',
			componentId: 'component-1',
			intervalUnit: 'weeks',
			intervalValue: 2,
			intervalSessions: 5,
			baselineSessionCount: 3,
		});
		request.flush({
			maintenancePlan: { ...plan, name: 'Clean bearings', intervalDays: 14 },
		});
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/maintenance-plans');
		});
		refresh?.flush({
			maintenancePlans: [{ ...plan, name: 'Clean bearings', intervalDays: 14 }],
			activity: [],
		});
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Clean bearings');
	});

	it('records ad hoc service with cost data through the car-scoped route', async () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.openServiceCreate();
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush({ components: [component] });
		app.serviceForm.set({
			carId: 'car-1',
			componentId: 'component-1',
			performedAt: '2026-08-02T10:00',
			description: 'Rebuilt the front diff',
			cost: '24.5',
			currency: 'usd',
		});
		app.saveService();
		const request = http.expectOne('/api/v1/cars/car-1/service-records');
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toMatchObject({
			description: 'Rebuilt the front diff',
			cost: 24.5,
			currency: 'USD',
		});
		request.flush({
			serviceRecord: {
				id: 'record-1',
				carId: 'car-1',
				performedAt: '2026-08-02T17:00:00.000Z',
				description: 'Rebuilt the front diff',
				cost: 24.5,
				currency: 'USD',
			},
		});
		let refresh: TestRequest | undefined;
		let planRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/service-records');
			planRefresh = http.expectOne('/api/v1/maintenance-plans');
		});
		refresh?.flush({
			serviceRecords: [
				{
					id: 'record-1',
					carId: 'car-1',
					performedAt: '2026-08-02T17:00:00.000Z',
					description: 'Rebuilt the front diff',
					cost: 24.5,
					currency: 'USD',
				},
			],
		});
		planRefresh?.flush({ maintenancePlans: [plan], activity: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(app.serviceRecords()[0].id).toBe('record-1');
	});

	it('completes a plan from the service form and sends notes and cost', async () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.openCompletion(plan);
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush({ components: [component] });
		app.serviceForm.update((form: Record<string, unknown>) => ({
			...form,
			description: 'Cleaned bearings',
			cost: '8',
			currency: 'CAD',
		}));
		app.saveService();
		const request = http.expectOne('/api/v1/maintenance-plans/plan-1/complete');
		expect(request.request.body).toMatchObject({
			description: 'Cleaned bearings',
			cost: 8,
			currency: 'CAD',
		});
		request.flush({
			serviceRecord: {
				id: 'record-2',
				planId: 'plan-1',
				carId: 'car-1',
				performedAt: '2026-08-02T17:00:00.000Z',
				description: 'Cleaned bearings',
				cost: 8,
				currency: 'CAD',
			},
			maintenancePlan: { ...plan, baselineAt: '2026-08-02T17:00:00.000Z' },
		});
		let serviceRefresh: TestRequest | undefined;
		let planRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			serviceRefresh = http.expectOne('/api/v1/service-records');
			planRefresh = http.expectOne('/api/v1/maintenance-plans');
		});
		serviceRefresh?.flush({ serviceRecords: [] });
		planRefresh?.flush({
			maintenancePlans: [{ ...plan, baselineAt: '2026-08-02T17:00:00.000Z' }],
			activity: [],
		});
		await fixture.whenStable();
		fixture.detectChanges();
		expect(app.plans()[0].baselineAt).toBe('2026-08-02T17:00:00.000Z');
	});

	it('soft-deletes a record and can undo the correction', async () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		const record = {
			id: 'record-3',
			carId: 'car-1',
			performedAt: '2026-08-02T00:00:00.000Z',
			description: 'Checked tires',
		};
		app.serviceRecords.set([record]);
		app.deleteService(record);
		const deletion = http.expectOne('/api/v1/service-records/record-3');
		expect(deletion.request.method).toBe('DELETE');
		deletion.flush({
			serviceRecord: { ...record, deletedAt: '2026-08-03T00:00:00.000Z' },
		});
		let deletedRefresh: TestRequest | undefined;
		let deletedPlanRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			deletedRefresh = http.expectOne('/api/v1/service-records');
			deletedPlanRefresh = http.expectOne('/api/v1/maintenance-plans');
		});
		deletedRefresh?.flush({
			serviceRecords: [{ ...record, deletedAt: '2026-08-03T00:00:00.000Z' }],
		});
		deletedPlanRefresh?.flush({ maintenancePlans: [plan], activity: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		app.restoreService({ ...record, deletedAt: '2026-08-03T00:00:00.000Z' });
		const restore = http.expectOne('/api/v1/service-records/record-3/restore');
		expect(restore.request.method).toBe('POST');
		restore.flush({ serviceRecord: record });
		let restoredRefresh: TestRequest | undefined;
		let restoredPlanRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			restoredRefresh = http.expectOne('/api/v1/service-records');
			restoredPlanRefresh = http.expectOne('/api/v1/maintenance-plans');
		});
		restoredRefresh?.flush({ serviceRecords: [record] });
		restoredPlanRefresh?.flush({ maintenancePlans: [plan], activity: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(app.serviceRecords()[0].deletedAt).toBeUndefined();
	});

	it('does not show a mixed-currency total in the history header', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.serviceRecords.set([
			{
				id: 'record-1',
				carId: 'car-1',
				performedAt: '2026-08-02T17:00:00.000Z',
				description: 'Rebuilt diff',
				cost: 24.5,
				currency: 'USD',
			},
			{
				id: 'record-2',
				carId: 'car-1',
				performedAt: '2026-08-03T17:00:00.000Z',
				description: 'Changed shocks',
				cost: 8,
				currency: 'CAD',
			},
		]);
		fixture.detectChanges();
		const historyTotal =
			fixture.nativeElement.querySelector('.history-total')?.textContent ?? '';
		expect(historyTotal).toContain('2 records');
		expect(historyTotal).not.toContain('logged');
		expect(historyTotal).not.toContain('32.50');
	});

	it('keeps archived-car plans read-only', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.garage.set([{ ...car, archivedAt: '2026-08-01T00:00:00.000Z' }]);
		fixture.detectChanges();
		expect(
			fixture.nativeElement.querySelector('.plan-actions .text-button')
				?.disabled,
		).toBe(true);
	});

	it('disables plan creation when every car is archived', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.garage.set([{ ...car, archivedAt: '2026-08-01T00:00:00.000Z' }]);
		app.plans.set([]);
		fixture.detectChanges();
		const creationButtons = [
			...fixture.nativeElement.querySelectorAll('button'),
		].filter((button: HTMLButtonElement) =>
			['New plan', 'Create a plan'].includes(button.textContent?.trim() ?? ''),
		) as HTMLButtonElement[];

		expect(creationButtons).toHaveLength(2);
		expect(creationButtons.every((button) => button.disabled)).toBe(true);
		app.openCreate();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('.maintenance-form')).toBeNull();
	});
});
