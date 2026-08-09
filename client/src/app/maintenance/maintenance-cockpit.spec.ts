import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsumableStore } from './consumables/consumable-store';
import { MaintenanceCockpit } from './maintenance-cockpit';
import { MaintenancePlanStore } from './maintenance-plan-store';
import type { MaintenancePlan } from './maintenance.models';
import { ServiceRecordStore } from './service-record-store';

const plan: MaintenancePlan = {
	id: 'plan-1',
	carId: 'car-1',
	componentId: null,
	name: 'Inspect bearings',
	status: 'active',
	dueStatus: 'due',
};

const planStore = {
	cars: signal([{ id: 'car-1', name: 'Buggy', archivedAt: null }]),
	plans: signal([plan]),
	timezone: signal('UTC'),
	components: signal([]),
	loading: signal(false),
	error: signal(''),
	action: signal<string | null>(null),
	outcome: signal({ status: 'idle' as const, operationId: null }),
	retry: vi.fn(),
	loadComponents: vi.fn(),
	mutate: vi.fn(),
};

const serviceStore = {
	cars: planStore.cars,
	timezone: planStore.timezone,
	records: signal([]),
	activity: signal([]),
	components: signal([]),
	loading: signal(false),
	error: signal(''),
	action: signal<string | null>(null),
	outcome: signal({ status: 'idle' as const, operationId: null }),
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
	activeEditor: ReturnType<typeof signal<'plan' | 'service' | null>>;
	completionPlan: ReturnType<typeof signal<MaintenancePlan | null>>;
	createPlanRequested: ReturnType<typeof signal<boolean>>;
	canCreatePlan(): boolean;
	openCreatePlan(): void;
	planEditing(editing: boolean): void;
	serviceEditing(editing: boolean): void;
	complete(plan: MaintenancePlan): void;
	closeCompletion(): void;
	load(): void;
};

describe('MaintenanceCockpit', () => {
	let fixture: ComponentFixture<MaintenanceCockpit>;

	beforeEach(async () => {
		vi.clearAllMocks();
		planStore.loading.set(false);
		planStore.error.set('');
		planStore.plans.set([plan]);
		planStore.outcome.set({ status: 'idle', operationId: null });
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
	});

	it('composes loading, failure, retry, and ready states', () => {
		const app = fixture.componentInstance as unknown as CockpitHarness;
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

	it('coordinates mutually exclusive editors and plan completion', () => {
		const app = fixture.componentInstance as unknown as CockpitHarness;
		const button = (label: string): HTMLButtonElement => {
			const found = [...fixture.nativeElement.querySelectorAll('button')].find(
				(candidate: HTMLButtonElement) =>
					candidate.textContent?.trim() === label && !candidate.disabled,
			);
			expect(found).toBeTruthy();
			return found as HTMLButtonElement;
		};
		button('New plan').click();
		fixture.detectChanges();
		expect(app.activeEditor()).toBe('plan');
		expect(app.createPlanRequested()).toBe(false);
		expect(
			fixture.nativeElement.querySelector('#maintenance-form-title'),
		).toBeTruthy();
		expect(
			fixture.nativeElement.querySelector('#service-history-title'),
		).toBeNull();

		button('Cancel').click();
		fixture.detectChanges();
		button('Log ad hoc service').click();
		fixture.detectChanges();
		expect(app.activeEditor()).toBe('service');
		button('Cancel').click();
		fixture.detectChanges();
		expect(app.activeEditor()).toBeNull();

		button('Complete').click();
		fixture.detectChanges();
		expect(app.completionPlan()).toBe(plan);
		expect(app.activeEditor()).toBe('service');
		expect(
			fixture.nativeElement.querySelector('#service-form-title'),
		).toBeTruthy();
		button('Cancel').click();
		fixture.detectChanges();
		expect(app.completionPlan()).toBeNull();
		expect(app.activeEditor()).toBeNull();
	});

	it('does not offer plan creation before a child or visible plan exists', () => {
		const app = fixture.componentInstance as unknown as CockpitHarness;
		planStore.plans.set([]);
		fixture.detectChanges();
		expect(app.canCreatePlan()).toBe(false);
		expect(
			fixture.nativeElement.querySelector(
				'[data-maintenance-launcher="new-plan"]',
			),
		).toBeTruthy();
	});
});
