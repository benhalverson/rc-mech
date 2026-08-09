import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { MaintenanceLookups } from './maintenance/maintenance-lookups';
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
	load: () => void;
	openCreate: (...args: unknown[]) => unknown;
	openEdit: (plan: MaintenancePlan) => void;
	cancelEdit: () => void;
	update: (field: string, value: string) => void;
	changePlanCar: (event: Event) => void;
	form: TestSignal<Record<string, string>>;
	save: (...args: unknown[]) => unknown;
	openServiceCreate: (...args: unknown[]) => unknown;
	openServiceEdit: (record: ServiceRecord) => void;
	cancelServiceEdit: () => void;
	updateService: (field: string, value: string) => void;
	changeServiceCar: (event: Event) => void;
	serviceForm: TestSignal<Record<string, string>>;
	saveService: (...args: unknown[]) => unknown;
	openCompletion: (...args: unknown[]) => unknown;
	serviceRecords: TestSignal<ServiceRecord[]>;
	plans: TestSignal<MaintenancePlan[]>;
	deleteService: (...args: unknown[]) => unknown;
	restoreService: (...args: unknown[]) => unknown;
	undoActivity: (...args: unknown[]) => unknown;
	transition: (
		plan: MaintenancePlan,
		action: 'pause' | 'resume' | 'archive',
	) => void;
	garage: TestSignal<unknown[]>;
	components: TestSignal<Array<{ id: string; name: string }>>;
	action: TestSignal<string | null>;
	serviceAction: TestSignal<string | null>;
	editing: TestSignal<boolean>;
	serviceEditing: TestSignal<boolean>;
	formError: TestSignal<string>;
	serviceError: TestSignal<string>;
	mutationError: TestSignal<string>;
	selectedFilter: TestSignal<string>;
	historyFilter: TestSignal<string>;
	visiblePlans: () => MaintenancePlan[];
	visibleServiceRecords: () => ServiceRecord[];
	totalServiceCost: () => number;
	serviceTotals: () => Array<{ currency: string; total: number }>;
	setFilter: (value: string) => void;
	setHistoryFilter: (value: 'active' | 'deleted') => void;
	carName: (carId: string) => string;
	componentName: (componentId?: string | null) => string;
	planState: (plan: MaintenancePlan) => string;
	isReadOnly: (plan: MaintenancePlan) => boolean;
	isRecordReadOnly: (record: ServiceRecord) => boolean;
	recordCarName: (record: ServiceRecord) => string;
	recordComponentName: (record: ServiceRecord) => string;
	recordCost: (record: ServiceRecord) => string;
	stateLabel: (state: string) => string;
	filterLabel: (state: string) => string;
	dueText: (plan: MaintenancePlan) => string;
	localDateTime: (date: Date) => string;
	toIso: (value: string) => string;
	loadComponents: (carId: string) => void;
	planFields: () => { invalid(): boolean; errorSummary(): unknown[] };
	serviceFields: () => { invalid(): boolean; errorSummary(): unknown[] };
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
				MaintenanceLookups,
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

	it('loads plan components from the selected car event value', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.openCreate();
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		const select = document.createElement('select');
		select.add(new Option('Blue Buggy', 'car-2'));
		select.value = 'car-2';
		select.addEventListener('change', (event) => app.changePlanCar(event));

		select.dispatchEvent(new Event('change'));

		expect(app.form()['carId']).toBe('car-2');
		http.expectOne('/api/v1/cars/car-2/components').flush({ components: [] });
	});

	it('loads service components from the selected car event value', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.openServiceCreate();
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		const select = document.createElement('select');
		select.add(new Option('Blue Buggy', 'car-2'));
		select.value = 'car-2';
		select.addEventListener('change', (event) => app.changeServiceCar(event));

		select.dispatchEvent(new Event('change'));

		expect(app.serviceForm()['carId']).toBe('car-2');
		http.expectOne('/api/v1/cars/car-2/components').flush({ components: [] });
	});

	afterEach(() => http.verify());

	it('groups date, drive-session, combined, timezone, and lifecycle states', () => {
		expect(calendarDays(2, 'weeks')).toBe(14);
		expect(calendarDays(1, 'months')).toBe(30);
		expect(calendarDays(3, 'days')).toBe(3);
		expect(calculatePlanState({ ...plan, dueStatus: 'due' })).toBe('due');
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
		expect(
			calculatePlanState(
				{
					...plan,
					baselineAt: null,
					intervalDays: null,
					baselineSessionCount: undefined,
				},
				new Date('2026-07-02T00:00:00.000Z'),
				5,
			),
		).toBe('due');
		let intervalReads = 0;
		const changingInterval = { ...plan, intervalSessions: null };
		Object.defineProperty(changingInterval, 'intervalDays', {
			get: () => {
				intervalReads += 1;
				return intervalReads < 3 ? 1 : undefined;
			},
		});
		expect(
			calculatePlanState(
				changingInterval,
				new Date('2026-07-03T00:00:00.000Z'),
			),
		).toBe('overdue');
		expect(calculatePlanState(plan, new Date('2026-08-02T00:00:00.000Z'))).toBe(
			'overdue',
		);
		expect(calculatePlanState({ ...plan, status: 'paused' })).toBe('paused');
		expect(calculatePlanState({ ...plan, status: 'archived' })).toBe(
			'archived',
		);
		expect(
			calculatePlanState(
				{
					...plan,
					nextDueAt: '2026-08-03T00:00:00.000Z',
				},
				new Date('2026-08-01T00:00:00.000Z'),
			),
		).toBe('due');
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

	it('retries and renders a cockpit read failure', async () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.load();
		await vi.waitFor(() =>
			http
				.expectOne((request) => request.url === '/api/v1/cars')
				.flush({ cars: [car] }),
		);
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/maintenance-plans')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'The maintenance ledger could not be loaded',
		);
		(
			fixture.nativeElement.querySelector(
				'.error-state button',
			) as HTMLButtonElement
		).click();
		await vi.waitFor(() =>
			http
				.expectOne((request) => request.url === '/api/v1/cars')
				.flush({ cars: [car] }),
		);
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/maintenance-plans')
			.flush({ maintenancePlans: [plan], activity: [] });
		http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
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

	it('creates a plan with only a calendar interval', async () => {
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
			sessionInterval: '',
			baselineAt: '2026-08-01T10:00',
			baselineSessions: '3',
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
			baselineSessionCount: 3,
		});
		expect(request.request.body.intervalSessions).toBeUndefined();
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

		expect(creationButtons).toHaveLength(1);
		expect(creationButtons.every((button) => button.disabled)).toBe(true);
		app.openCreate();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('.maintenance-form')).toBeNull();
	});

	it('filters plans and service records and calculates currency totals', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		const active: ServiceRecord = {
			id: 'record-active',
			carId: 'car-1',
			performedAt: '2026-08-02T00:00:00.000Z',
			description: 'Active',
			cost: 10,
			currency: null,
		};
		const second: ServiceRecord = {
			...active,
			id: 'record-second',
			cost: 5,
			currency: 'CAD',
		};
		const deleted = {
			...active,
			id: 'record-deleted',
			cost: null,
			deletedAt: '2026-08-03T00:00:00.000Z',
		};
		const noCost = { ...active, id: 'record-no-cost', cost: undefined };
		app.serviceRecords.set([active, second, noCost, deleted]);
		expect(app.visibleServiceRecords()).toEqual([active, second, noCost]);
		expect(app.totalServiceCost()).toBe(15);
		expect(app.serviceTotals()).toEqual([
			{ currency: 'USD', total: 10 },
			{ currency: 'CAD', total: 5 },
		]);
		app.setHistoryFilter('deleted');
		expect(app.visibleServiceRecords()).toEqual([deleted]);

		app.plans.set([
			{ ...plan, dueStatus: 'due' },
			{ ...plan, id: 'paused', status: 'paused' },
		]);
		app.setFilter('due');
		expect(app.visiblePlans()).toHaveLength(1);
		app.setFilter('all');
		expect(app.visiblePlans()).toHaveLength(2);
	});

	it('opens plan edits for every persisted interval representation', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.openEdit({
			...plan,
			componentId: null,
			intervalUnit: 'none',
			intervalValue: null,
			intervalDays: null,
			intervalSessions: null,
			baselineAt: null,
			baselineSessionCount: null,
		});
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		expect(app.form()).toMatchObject({
			componentId: '',
			calendarValue: '',
			calendarUnit: 'days',
			sessionInterval: '',
			baselineAt: '',
			baselineSessions: '0',
		});
		app.cancelEdit();

		app.openEdit({
			...plan,
			intervalUnit: 'months',
			intervalValue: 2,
			intervalDays: 60,
			baselineSessionCount: 4,
		});
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		expect(app.form()).toMatchObject({
			calendarValue: '2',
			calendarUnit: 'months',
			sessionInterval: '5',
			baselineSessions: '4',
		});
		app.cancelEdit();
		app.openEdit({
			...plan,
			intervalUnit: 'days',
			intervalValue: null,
			intervalDays: 30,
		});
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		expect(app.form()['calendarValue']).toBe('30');
		app.cancelEdit();
		app.openEdit({
			...plan,
			intervalUnit: 'days',
			intervalValue: null,
			intervalDays: null,
		});
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		expect(app.form()['calendarValue']).toBe('');
	});

	it('guards plan editing and handles changing active-car availability', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.openEdit({ ...plan, status: 'archived' });
		http.expectNone((request) => request.url.includes('/components'));
		expect(app.editing()).toBe(false);

		let reads = 0;
		app.garage.set([
			{
				id: 'car-1',
				name: 'Changing car',
				get archivedAt() {
					reads += 1;
					return reads > 1 ? '2026-08-01T00:00:00.000Z' : null;
				},
			},
		]);
		app.openCreate();
		expect(app.form()['carId']).toBe('');
		expect(app.components()).toEqual([]);
	});

	it('covers plan validation focus paths and interval guards', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		const expectFieldError = (selector: string, message: string): void => {
			fixture.detectChanges();
			expect(
				fixture.nativeElement.querySelector(selector)?.textContent,
			).toContain(message);
		};
		app.openCreate();
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		app.form.set({ ...app.form(), carId: '', name: '' });
		app.save();
		expect(app.formError()).toContain('Choose a car');
		expectFieldError('#plan-car-error', 'Choose a car');
		app.form.set({ ...app.form(), carId: 'car-1', name: '' });
		app.save();
		expect(app.formError()).toContain('Name the care rule');
		expectFieldError('#plan-name-error', 'Name the care rule');
		app.form.set({ ...app.form(), name: '   ' });
		app.save();
		expect(app.formError()).toContain('Name the care rule');
		app.form.set({
			...app.form(),
			name: 'Plan',
			calendarValue: 'half',
		});
		app.save();
		expect(app.formError()).toContain('whole numbers');
		expectFieldError('#plan-calendar-error', 'whole numbers');
		app.form.set({ ...app.form(), calendarValue: '', sessionInterval: '0' });
		app.save();
		expect(app.formError()).toContain('at least one');
		expectFieldError('#plan-session-error', 'at least one');
		app.form.set({
			...app.form(),
			sessionInterval: '2',
			baselineSessions: 'half',
		});
		app.save();
		expect(app.formError()).toContain('Prior sessions');
		expectFieldError('#plan-baseline-error', 'Prior sessions');
		app.form.set({
			...app.form(),
			baselineSessions: '0',
			calendarValue: '',
			sessionInterval: '',
		});
		app.save();
		expect(app.formError()).toContain('calendar interval');
		expectFieldError('#plan-calendar-error', 'calendar interval');
		expectFieldError('#plan-session-error', 'calendar interval');

		Object.defineProperty(app.planFields(), 'invalid', { value: () => false });
		app.form.set({
			...app.form(),
			baselineSessions: '0',
			sessionInterval: '1.5',
		});
		app.save();
		expect(app.formError()).toContain('whole numbers greater than zero');
		app.form.set({ ...app.form(), calendarValue: '0', sessionInterval: '' });
		app.save();
		expect(app.formError()).toContain('whole numbers greater than zero');
		app.form.set({ ...app.form(), calendarValue: '', sessionInterval: '' });
		app.save();
		expect(app.formError()).toContain('calendar interval');
		app.action.set('busy');
		app.form.set({ ...app.form(), calendarValue: '1' });
		app.save();
		http.expectNone((request) => request.url === '/api/v1/maintenance-plans');
	});

	it('uses plan validation fallback and maps every save failure', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.openCreate();
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		Object.defineProperty(app.planFields(), 'errorSummary', {
			value: () => [],
		});
		app.form.set({ ...app.form(), carId: '', name: '' });
		app.save();
		expect(app.formError()).toBe('Review the maintenance plan fields.');

		Object.defineProperty(app.planFields(), 'invalid', { value: () => false });
		app.form.set({
			...app.form(),
			carId: 'car-1',
			name: 'Plan',
			calendarValue: '1',
			calendarUnit: 'days',
			sessionInterval: '',
			baselineAt: '',
			baselineSessions: '',
			componentId: '',
		});
		for (const [status, message] of [
			[401, 'session has expired'],
			[409, 'car is archived'],
			[500, 'could not be saved'],
		] as const) {
			app.save();
			http
				.expectOne('/api/v1/maintenance-plans')
				.flush('failed', { status, statusText: 'Failed' });
			expect(app.formError()).toContain(message);
		}
	});

	it('updates a plan with only a drive-session threshold', async () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.openEdit(plan);
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		app.form.set({
			...app.form(),
			calendarValue: '',
			sessionInterval: '3',
			baselineAt: '',
			baselineSessions: '0',
		});
		app.save();
		const update = http.expectOne('/api/v1/maintenance-plans/plan-1');
		expect(update.request.method).toBe('PATCH');
		expect(update.request.body).toMatchObject({
			intervalUnit: 'none',
			intervalValue: 1,
			intervalSessions: 3,
		});
		update.flush({ maintenancePlan: plan });
		await vi.waitFor(() =>
			http
				.expectOne('/api/v1/maintenance-plans')
				.flush({ maintenancePlans: [plan], activity: [] }),
		);
	});

	it('edits service records with defaults and rejects read-only records', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		const record: ServiceRecord = {
			id: 'record-edit',
			carId: 'car-1',
			performedAt: '2026-08-02T00:00:00.000Z',
			description: 'Checked car',
		};
		app.openServiceEdit({ ...record, deletedAt: '2026-08-03T00:00:00.000Z' });
		expect(app.serviceEditing()).toBe(false);
		app.openServiceEdit(record);
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		expect(app.serviceForm()).toMatchObject({
			componentId: '',
			notes: '',
			cost: '',
			currency: 'USD',
		});
		app.cancelServiceEdit();
		app.openServiceEdit({
			...record,
			componentId: 'component-1',
			planId: 'plan-1',
			notes: 'Correction',
			cost: 12,
			currency: 'CAD',
		});
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		expect(app.serviceForm()).toMatchObject({
			componentId: 'component-1',
			notes: 'Correction',
			cost: '12',
			currency: 'CAD',
		});
	});

	it('guards completion and transition for read-only plans and defaults completion component', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		const archived = { ...plan, status: 'archived' as const };
		app.openCompletion(archived);
		app.transition(archived, 'resume');
		http.expectNone((request) => request.url.includes('plan-1'));

		app.openCompletion({ ...plan, componentId: null });
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		expect(app.serviceForm()['componentId']).toBe('');
	});

	it('covers service validation, action guard, and selected-value fallbacks', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		const expectFieldError = (selector: string, message: string): void => {
			fixture.detectChanges();
			expect(
				fixture.nativeElement.querySelector(selector)?.textContent,
			).toContain(message);
		};
		app.garage.set([]);
		app.openServiceCreate();
		expect(app.serviceForm()['carId']).toBe('');
		app.changeServiceCar({
			target: document.createElement('input'),
		} as unknown as Event);
		app.changePlanCar({
			target: document.createElement('input'),
		} as unknown as Event);
		app.updateService('notes', 'Updated');
		app.update('name', 'Updated');

		app.serviceForm.set({
			...app.serviceForm(),
			performedAt: '',
			description: '',
		});
		app.saveService();
		expect(app.serviceError()).toContain('Choose a car');
		expectFieldError('#service-car-error', 'Choose a car');
		app.serviceForm.set({
			...app.serviceForm(),
			carId: 'car-1',
			performedAt: '',
			description: 'Work',
		});
		app.saveService();
		expect(app.serviceError()).toContain('completion date');
		expectFieldError('#service-date-error', 'completion date');
		app.serviceForm.set({
			...app.serviceForm(),
			performedAt: '2026-08-02T10:00',
			description: '',
		});
		app.saveService();
		expect(app.serviceError()).toContain('completed work');
		expectFieldError('#service-description-error', 'completed work');
		app.serviceForm.set({
			...app.serviceForm(),
			description: '   ',
		});
		app.saveService();
		expect(app.serviceError()).toContain('completed work');
		app.serviceForm.set({
			...app.serviceForm(),
			description: 'Work',
			cost: '-1',
		});
		app.saveService();
		expect(app.serviceError()).toContain('Cost');
		expectFieldError('#service-cost-error', 'Cost');
		app.serviceForm.set({ ...app.serviceForm(), cost: '', currency: 'US' });
		app.saveService();
		expect(app.serviceError()).toContain('three-letter');
		expectFieldError('#service-currency-error', 'three-letter');
		app.serviceForm.set({
			...app.serviceForm(),
			currency: 'USD',
			notes: 'x'.repeat(4001),
		});
		app.saveService();
		expect(app.serviceError()).toContain('4,000');
		expectFieldError('#service-notes-error', '4,000');
		app.serviceAction.set('busy');
		app.serviceForm.set({ ...app.serviceForm(), notes: '' });
		app.saveService();
		http.expectNone((request) => request.url.includes('service-records'));
	});

	it('uses service validation fallback and maps service save failures', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.openServiceCreate();
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		Object.defineProperty(app.serviceFields(), 'errorSummary', {
			value: () => [],
		});
		app.serviceForm.set({ ...app.serviceForm(), carId: '', performedAt: '' });
		app.saveService();
		expect(app.serviceError()).toBe('Review the service record fields.');

		Object.defineProperty(app.serviceFields(), 'invalid', {
			value: () => false,
		});
		app.serviceForm.set({
			...app.serviceForm(),
			carId: 'car-1',
			performedAt: '2026-08-02T10:00',
			description: 'Work',
			notes: '',
			cost: '-1',
			currency: 'USD',
			componentId: '',
		});
		app.saveService();
		expect(app.serviceError()).toContain('Cost');
		app.serviceForm.set({ ...app.serviceForm(), cost: '' });
		for (const [status, message] of [
			[409, 'car is archived'],
			[401, 'session has expired'],
			[500, 'could not be saved'],
		] as const) {
			app.saveService();
			http
				.expectOne('/api/v1/cars/car-1/service-records')
				.flush('failed', { status, statusText: 'Failed' });
			expect(app.serviceError()).toContain(message);
		}
	});

	it('saves corrected service records and optional payload branches', async () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		const record: ServiceRecord = {
			id: 'record-edit',
			carId: 'car-1',
			performedAt: '2026-08-02T00:00:00.000Z',
			description: 'Checked car',
		};
		app.openServiceEdit(record);
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		app.serviceForm.set({
			...app.serviceForm(),
			performedAt: '2026-08-02T10:00',
			description: ' Corrected ',
			notes: ' Note ',
			cost: '0',
			currency: '   ',
		});
		app.saveService();
		const update = http.expectOne('/api/v1/service-records/record-edit');
		expect(update.request.body).toMatchObject({
			description: 'Corrected',
			notes: 'Note',
			cost: 0,
			currency: 'USD',
		});
		update.flush({ serviceRecord: record });
		await vi.waitFor(() => {
			http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
			http
				.expectOne('/api/v1/maintenance-plans')
				.flush({ maintenancePlans: [plan], activity: [] });
		});
	});

	it('maps service archive, restore, and activity undo failures and successes', async () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		const record: ServiceRecord = {
			id: 'record-actions',
			carId: 'car-1',
			performedAt: '2026-08-02T00:00:00.000Z',
			description: 'Checked car',
		};
		app.serviceAction.set('busy');
		app.deleteService(record);
		http.expectNone('/api/v1/service-records/record-actions');
		app.serviceAction.set(null);
		app.deleteService(record);
		http
			.expectOne('/api/v1/service-records/record-actions')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		expect(app.serviceError()).toContain('could not be archived');

		app.restoreService({ ...record, deletedAt: '2026-08-03T00:00:00.000Z' });
		http
			.expectOne('/api/v1/service-records/record-actions/restore')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		expect(app.serviceError()).toContain('could not be restored');

		app.undoActivity({
			id: 'activity-fail',
			action: 'Completed',
			occurredAt: '2026-08-01T00:00:00.000Z',
		});
		http
			.expectOne('/api/v1/service-records/activity-fail')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		expect(app.mutationError()).toContain('could not be undone');

		app.undoActivity({
			id: 'activity-ok',
			action: 'Completed',
			occurredAt: '2026-08-01T00:00:00.000Z',
		});
		http.expectOne('/api/v1/service-records/activity-ok').flush({});
		await vi.waitFor(() => {
			http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
			http
				.expectOne('/api/v1/maintenance-plans')
				.flush({ maintenancePlans: [plan], activity: [] });
		});
	});

	it('labels plan, component, service, and due-state fallbacks', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.components.set([component]);
		expect(app.carName('missing')).toBe('Unknown car');
		expect(app.componentName()).toBe('Car-level plan');
		expect(app.componentName('missing')).toBe('Installed component');
		expect(app.componentName('component-1')).toBe('Race motor');
		expect(app.planState({ ...plan, dueStatus: 'paused' })).toBe('paused');
		expect(app.isReadOnly({ ...plan, status: 'archived' })).toBe(true);
		expect(
			app.isRecordReadOnly({
				id: 'deleted',
				carId: 'car-1',
				performedAt: '2026-08-01T00:00:00.000Z',
				description: 'Deleted',
				deletedAt: '2026-08-02T00:00:00.000Z',
			}),
		).toBe(true);
		const garageRecord: ServiceRecord = {
			id: 'record',
			carId: 'car-1',
			performedAt: '2026-08-01T00:00:00.000Z',
			description: 'Work',
		};
		expect(app.recordCarName(garageRecord)).toBe('Red Runner');
		expect(app.recordComponentName(garageRecord)).toBe('Garage service');
		expect(
			app.recordComponentName({ ...garageRecord, componentId: 'component-1' }),
		).toBe('Race motor');
		expect(app.recordCost(garageRecord)).toBe('No cost logged');
		expect(app.recordCost({ ...garageRecord, cost: 2, currency: null })).toBe(
			'USD 2.00',
		);
		expect(app.stateLabel('upcoming')).toBe('Upcoming');
		expect(app.stateLabel('overdue')).toBe('Overdue');
		expect(app.filterLabel('all')).toBe('Everything');
		expect(app.filterLabel('due')).toBe('Due');
		expect(app.dueText({ ...plan, dueStatus: 'overdue' })).toBe(
			'Needs attention',
		);
		expect(app.dueText({ ...plan, dueStatus: 'due' })).toBe('Due now');
		expect(app.dueText({ ...plan, dueStatus: 'paused' })).toBe('Paused');
		expect(app.dueText({ ...plan, dueStatus: 'archived' })).toBe('Archived');
		expect(
			app.dueText({
				...plan,
				dueStatus: 'upcoming',
				dateDueAt: '2026-08-20T00:00:00.000Z',
			}),
		).toContain('Due Aug 20');
		expect(
			app.dueText({
				...plan,
				dueStatus: 'upcoming',
				dateDueAt: null,
				nextDueAt: null,
			}),
		).toBe('Baseline set');
	});

	it('handles date and component lookup fallbacks', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		expect(app.toIso('')).toBe('');
		expect(app.toIso('2026-08-01')).toBe('');
		app.loadComponents('');
		expect(app.components()).toEqual([]);
		app.loadComponents('car-1');
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		expect(app.components()).toEqual([]);

		const browserIntl = Intl;
		vi.stubGlobal('Intl', {
			DateTimeFormat: class {
				formatToParts(): Intl.DateTimeFormatPart[] {
					return [];
				}
			},
		});
		expect(app.localDateTime(new Date('2026-08-01T00:00:00.000Z'))).toBe(
			'--T:',
		);
		vi.stubGlobal('Intl', browserIntl);
	});

	it('executes every cockpit action through the rendered controls', async () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		const plans: MaintenancePlan[] = [
			{ ...plan, id: 'overdue', dueStatus: 'overdue' },
			{ ...plan, id: 'due', dueStatus: 'due' },
			{
				...plan,
				id: 'upcoming',
				dueStatus: 'upcoming',
				intervalValue: 2,
				intervalUnit: null,
				intervalSessions: null,
				nextDueAt: '2026-08-20T00:00:00.000Z',
			},
			{ ...plan, id: 'paused', status: 'paused' },
			{ ...plan, id: 'archived', status: 'archived' },
		];
		const active: ServiceRecord = {
			id: 'record-active',
			carId: 'car-1',
			componentId: 'component-1',
			planId: 'plan-1',
			performedAt: '2026-08-02T00:00:00.000Z',
			description: 'Scheduled work',
			notes: 'Measured carefully',
			cost: 10,
			currency: 'USD',
		};
		const adHoc: ServiceRecord = {
			...active,
			id: 'record-ad-hoc',
			componentId: null,
			planId: null,
			description: 'Ad hoc work',
			cost: null,
			notes: null,
		};
		const deleted = {
			...active,
			id: 'record-deleted',
			deletedAt: '2026-08-03T00:00:00.000Z',
		};
		app.components.set([component]);
		app.plans.set(plans);
		app.serviceRecords.set([active, adHoc, deleted]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('USD 10.00');
		expect(fixture.nativeElement.textContent).toContain('Measured carefully');

		const byText = (label: string): HTMLButtonElement => {
			const button = [...fixture.nativeElement.querySelectorAll('button')].find(
				(candidate: HTMLButtonElement) =>
					candidate.textContent?.trim() === label && !candidate.disabled,
			);
			expect(button).toBeTruthy();
			return button as HTMLButtonElement;
		};

		for (const label of [
			'Overdue',
			'Due',
			'Upcoming',
			'Paused',
			'Archived',
			'Everything',
		]) {
			byText(label).click();
			fixture.detectChanges();
		}

		byText('New plan').click();
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush({ components: [component] });
		fixture.detectChanges();
		app.action.set('create');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Creating…');
		app.action.set('edit');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Saving…');
		app.action.set(null);
		fixture.detectChanges();
		byText('Cancel').click();
		fixture.detectChanges();

		byText('Log ad hoc service').click();
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush({ components: [component] });
		fixture.detectChanges();
		for (const [action, label] of [
			['create', 'Recording…'],
			['edit', 'Saving…'],
			['complete', 'Completing…'],
		] as const) {
			app.serviceAction.set(action);
			fixture.detectChanges();
			expect(fixture.nativeElement.textContent).toContain(label);
		}
		app.serviceAction.set(null);
		fixture.detectChanges();
		byText('Cancel').click();
		fixture.detectChanges();

		const row = (id: string): HTMLElement =>
			[...fixture.nativeElement.querySelectorAll('.plan-row')].find(
				(candidate: HTMLElement) =>
					candidate.querySelector('h3')?.textContent ===
						plans.find((item) => item.id === id)?.name &&
					candidate.classList.contains(
						`plan-${plans.find((item) => item.id === id)?.dueStatus ?? plans.find((item) => item.id === id)?.status}`,
					),
			) as HTMLElement;
		const clickIn = (container: HTMLElement, label: string): void => {
			const button = [...container.querySelectorAll('button')].find(
				(candidate) => candidate.textContent?.trim() === label,
			);
			expect(button).toBeTruthy();
			button?.click();
		};

		clickIn(row('overdue'), 'Edit');
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush({ components: [component] });
		fixture.detectChanges();
		byText('Cancel').click();
		fixture.detectChanges();
		clickIn(row('overdue'), 'Pause');
		http
			.expectOne('/api/v1/maintenance-plans/overdue/pause')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		clickIn(row('overdue'), 'Archive');
		http
			.expectOne('/api/v1/maintenance-plans/overdue/archive')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		clickIn(row('paused'), 'Resume');
		http
			.expectOne('/api/v1/maintenance-plans/paused/resume')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		clickIn(row('due'), 'Complete');
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush({ components: [component] });
		fixture.detectChanges();
		byText('Cancel').click();
		fixture.detectChanges();

		byText('Archived corrections').click();
		fixture.detectChanges();
		byText('Undo').click();
		http
			.expectOne('/api/v1/service-records/record-deleted/restore')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		fixture.detectChanges();
		byText('Current ledger').click();
		fixture.detectChanges();
		byText('Correct').click();
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush({ components: [component] });
		fixture.detectChanges();
		byText('Cancel').click();
		fixture.detectChanges();
		clickIn(
			fixture.nativeElement.querySelector('.service-row') as HTMLElement,
			'Archive',
		);
		http
			.expectOne('/api/v1/service-records/record-active')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
	});

	it('submits both rendered forms and changes their car selectors', async () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.openCreate();
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		fixture.detectChanges();
		const planForm = fixture.nativeElement.querySelector(
			'form:not(.service-form)',
		) as HTMLFormElement;
		const planCar = planForm.querySelector('select') as HTMLSelectElement;
		planCar.add(new Option('Blue', 'car-2'));
		planCar.value = 'car-2';
		planCar.dispatchEvent(new Event('change'));
		http.expectOne('/api/v1/cars/car-2/components').flush({ components: [] });
		planForm.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(app.formError()).toBeTruthy();
		app.cancelEdit();

		app.openServiceCreate();
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		fixture.detectChanges();
		const serviceForm = fixture.nativeElement.querySelector(
			'form.service-form',
		) as HTMLFormElement;
		const serviceCar = serviceForm.querySelector('select') as HTMLSelectElement;
		serviceCar.add(new Option('Blue', 'car-2'));
		serviceCar.value = 'car-2';
		serviceCar.dispatchEvent(new Event('change'));
		http.expectOne('/api/v1/cars/car-2/components').flush({ components: [] });
		serviceForm.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(app.serviceError()).toBeTruthy();
	});

	it('renders activity details and invokes undo from the activity feed', async () => {
		const store = TestBed.inject(MaintenanceStore);
		store.plansResource.reload();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/maintenance-plans').flush({
				maintenancePlans: [plan],
				activity: [
					{
						id: 'activity-1',
						action: 'Completed bearings',
						occurredAt: '2026-08-02T00:00:00.000Z',
						note: 'Looked good',
					},
					{
						id: 'activity-2',
						action: 'Reset baseline',
						occurredAt: '2026-08-03T00:00:00.000Z',
					},
				],
			}),
		);
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Looked good');
		const undo = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) =>
				button.textContent?.trim() === 'Undo completion',
		) as HTMLButtonElement;
		undo.click();
		http
			.expectOne('/api/v1/service-records/activity-1')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
	});

	it('renders archived car options, empty views, and interval unit fallback', () => {
		const app = fixture.componentInstance as unknown as MaintenanceTestHarness;
		app.garage.set([
			car,
			{ ...car, id: 'car-archived', archivedAt: '2026-08-01T00:00:00.000Z' },
		]);
		app.openCreate();
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		fixture.detectChanges();
		expect(
			fixture.nativeElement.querySelectorAll('form select option').length,
		).toBeGreaterThan(0);
		app.cancelEdit();
		app.openServiceCreate();
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
		fixture.detectChanges();
		app.cancelServiceEdit();

		app.plans.set([
			{
				...plan,
				id: 'unit-fallback',
				intervalValue: 2,
				intervalUnit: null,
				dueStatus: 'upcoming',
			},
		]);
		app.serviceRecords.set([]);
		app.setHistoryFilter('active');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('every 2 days');
		expect(fixture.nativeElement.textContent).toContain(
			'No service recorded yet',
		);
		app.setHistoryFilter('deleted');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'No archived service records',
		);

		app.plans.set([]);
		fixture.detectChanges();
		const create = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) =>
				button.textContent?.trim() === 'Create a plan',
		) as HTMLButtonElement;
		create.click();
		http.expectOne('/api/v1/cars/car-1/components').flush({ components: [] });
	});
});
