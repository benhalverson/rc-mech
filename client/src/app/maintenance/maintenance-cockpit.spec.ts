import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsumableStore } from './consumables/consumable-store';
import type {
	MaintenanceCar,
	MaintenancePlan,
	ServiceRecord,
} from './maintenance.models';
import { MaintenanceCockpit } from './maintenance-cockpit';
import {
	type MaintenancePlanOutcome,
	MaintenancePlanStore,
} from './maintenance-plan-store';
import {
	type ServiceRecordOutcome,
	ServiceRecordStore,
} from './service-record-store';

const car: MaintenanceCar = { id: 'car-1', name: 'Buggy', archivedAt: null };
const plan: MaintenancePlan = {
	id: 'plan-1',
	carId: 'car-1',
	componentId: null,
	name: 'Inspect bearings',
	status: 'active',
	dueStatus: 'due',
};
const record: ServiceRecord = {
	id: 'record-1',
	carId: 'car-1',
	performedAt: '2026-08-09T12:30:00.000Z',
	description: 'Serviced bearings',
	cost: 12,
	currency: 'USD',
};

const planStore = {
	cars: signal<MaintenanceCar[]>([car]),
	plans: signal<MaintenancePlan[]>([plan]),
	timezone: signal('UTC'),
	components: signal([]),
	loading: signal(false),
	error: signal(''),
	action: signal<string | null>(null),
	outcome: signal<MaintenancePlanOutcome>({
		status: 'idle',
		operationId: null,
	}),
	retry: vi.fn(),
	loadComponents: vi.fn(),
	mutate: vi.fn(),
};

const serviceStore = {
	cars: planStore.cars,
	timezone: planStore.timezone,
	records: signal<ServiceRecord[]>([record]),
	activity: signal([]),
	components: signal([]),
	loading: signal(false),
	error: signal(''),
	action: signal<string | null>(null),
	outcome: signal<ServiceRecordOutcome>({ status: 'idle', operationId: null }),
	retry: vi.fn(),
	loadComponents: vi.fn(),
	mutate: vi.fn(),
};

const consumableStore = {
	cars: planStore.cars,
	timezone: planStore.timezone,
	entries: signal([]),
	report: signal(null),
	loading: signal(false),
	error: signal(''),
	action: signal(null),
	outcome: signal({ status: 'idle' as const, operationId: null }),
	tireLookup: signal({ status: 'idle' as const, carId: null }),
	retry: vi.fn(),
	loadTires: vi.fn(),
	mutate: vi.fn(),
};

type CockpitHarness = {
	activeEditor: ReturnType<typeof signal<unknown | null>>;
	serviceFilter: ReturnType<typeof signal<'active' | 'deleted'>>;
	canCreatePlan(): boolean;
	hasActiveCars(): boolean;
	createPlan(): void;
	createService(): void;
	closeEditor(): void;
	load(): void;
};

describe('MaintenanceCockpit', () => {
	let fixture: ComponentFixture<MaintenanceCockpit>;
	let app: CockpitHarness;

	beforeEach(async () => {
		vi.clearAllMocks();
		planStore.cars.set([car]);
		planStore.loading.set(false);
		planStore.error.set('');
		planStore.plans.set([plan]);
		planStore.outcome.set({ status: 'idle', operationId: null });
		serviceStore.records.set([record]);
		serviceStore.loading.set(false);
		serviceStore.error.set('');
		serviceStore.outcome.set({ status: 'idle', operationId: null });
		await TestBed.configureTestingModule({
			imports: [MaintenanceCockpit],
			providers: [
				{ provide: MaintenancePlanStore, useValue: planStore },
				{ provide: ServiceRecordStore, useValue: serviceStore },
				{ provide: ConsumableStore, useValue: consumableStore },
			],
		}).compileComponents();
		fixture = TestBed.createComponent(MaintenanceCockpit);
		fixture.detectChanges();
		app = fixture.componentInstance as unknown as CockpitHarness;
	});

	const button = (label: string): HTMLButtonElement => {
		const found = [...fixture.nativeElement.querySelectorAll('button')].find(
			(candidate: HTMLButtonElement) =>
				candidate.textContent?.trim() === label && !candidate.disabled,
		);
		expect(found).toBeTruthy();
		return found as HTMLButtonElement;
	};

	it('composes loading, failure, retry, and ready states', () => {
		planStore.loading.set(true);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Opening care ledger');
		planStore.loading.set(false);
		serviceStore.error.set('Service read failed');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Service read failed');
		(
			fixture.nativeElement.querySelector('.error-state button') as HTMLElement
		).click();
		expect(planStore.retry).toHaveBeenCalledOnce();
		expect(serviceStore.retry).toHaveBeenCalledOnce();
		serviceStore.error.set('');
		fixture.detectChanges();
		expect(app.canCreatePlan()).toBe(true);
		expect(fixture.nativeElement.textContent).toContain('Inspect bearings');
	});

	it('preserves summary, toolbar, plan, and service-history layout order', () => {
		const cockpit = fixture.nativeElement.querySelector(
			'.maintenance-cockpit',
		) as HTMLElement;
		const serviceTotals = cockpit.querySelector(
			'.service-totals',
		) as HTMLElement;
		const planTotals = cockpit.querySelector(
			'.maintenance-totals',
		) as HTMLElement;
		const toolbar = cockpit.querySelector('.cockpit-toolbar') as HTMLElement;
		const planList = cockpit.querySelector('.plan-list') as HTMLElement;
		const history = cockpit.querySelector('.service-history') as HTMLElement;
		expect(serviceTotals.compareDocumentPosition(planTotals)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(planTotals.compareDocumentPosition(toolbar)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(toolbar.compareDocumentPosition(planList)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(planList.compareDocumentPosition(history)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(toolbar.textContent).toContain('Log ad hoc service');
		button('Archived corrections').click();
		fixture.detectChanges();
		expect(app.serviceFilter()).toBe('deleted');
	});

	it('coordinates typed plan, service, edit, and completion requests', () => {
		button('New plan').click();
		fixture.detectChanges();
		expect(app.activeEditor()).toMatchObject({
			workflow: 'plan',
			request: { kind: 'create' },
		});
		expect(
			fixture.nativeElement.querySelector('#maintenance-form-title'),
		).toBeTruthy();
		expect(
			fixture.nativeElement.querySelector('#service-history-title'),
		).toBeNull();
		button('Cancel').click();
		fixture.detectChanges();

		button('Edit').click();
		fixture.detectChanges();
		expect(app.activeEditor()).toMatchObject({
			workflow: 'plan',
			request: { kind: 'edit' },
		});
		button('Cancel').click();
		fixture.detectChanges();
		button('Log ad hoc service').click();
		fixture.detectChanges();
		expect(app.activeEditor()).toMatchObject({
			workflow: 'service',
			request: { kind: 'create' },
		});
		button('Cancel').click();
		fixture.detectChanges();
		button('Correct').click();
		fixture.detectChanges();
		expect(app.activeEditor()).toMatchObject({
			workflow: 'service',
			request: { kind: 'edit' },
		});
		button('Cancel').click();
		fixture.detectChanges();
		button('Complete').click();
		fixture.detectChanges();
		expect(app.activeEditor()).toMatchObject({
			workflow: 'service',
			request: { kind: 'complete' },
		});
		expect(
			fixture.nativeElement.querySelector('#service-form-title'),
		).toBeTruthy();
		button('Cancel').click();
		fixture.detectChanges();
		expect(app.activeEditor()).toBeNull();
	});

	it('preserves filtered creation visibility and archived-car disabling', () => {
		button('Overdue').click();
		fixture.detectChanges();
		expect(app.canCreatePlan()).toBe(false);
		expect(
			fixture.nativeElement.querySelector(
				'header [data-maintenance-launcher="new-plan"]',
			),
		).toBeNull();
		button('Everything').click();
		fixture.detectChanges();
		planStore.plans.set([]);
		fixture.detectChanges();
		button('Create a plan').click();
		fixture.detectChanges();
		expect(app.activeEditor()).toMatchObject({ workflow: 'plan' });
		button('Cancel').click();
		fixture.detectChanges();
		planStore.plans.set([plan]);
		planStore.cars.set([{ ...car, archivedAt: '2026-08-01' }]);
		fixture.detectChanges();
		expect(app.hasActiveCars()).toBe(false);
		const topCreate = fixture.nativeElement.querySelector(
			'header [data-maintenance-launcher="new-plan"]',
		) as HTMLButtonElement;
		expect(topCreate.disabled).toBe(true);
		app.createPlan();
		app.createService();
		expect(app.activeEditor()).toBeNull();
		planStore.plans.set([]);
		fixture.detectChanges();
		expect(
			fixture.nativeElement.querySelector(
				'.empty-state [data-maintenance-launcher="new-plan"]',
			),
		).toBeTruthy();
	});

	it('closes each editor through its semantic saved intent', () => {
		button('New plan').click();
		fixture.detectChanges();
		planStore.outcome.set({
			status: 'succeeded',
			operationId: 1,
			command: {
				kind: 'save-plan',
				mode: 'create',
				id: null,
				plan: {
					carId: 'car-1',
					name: 'Plan',
					intervalUnit: 'days',
					intervalValue: 1,
					baselineSessionCount: 0,
				},
			},
		});
		fixture.detectChanges();
		expect(app.activeEditor()).toBeNull();

		button('Log ad hoc service').click();
		fixture.detectChanges();
		serviceStore.outcome.set({
			status: 'succeeded',
			operationId: 1,
			command: {
				kind: 'save-service',
				mode: 'create',
				carId: 'car-1',
				id: null,
				service: { performedAt: record.performedAt, description: 'Work' },
			},
		});
		fixture.detectChanges();
		expect(app.activeEditor()).toBeNull();
	});
});
