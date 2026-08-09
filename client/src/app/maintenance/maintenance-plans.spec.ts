import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	MaintenanceCar,
	MaintenancePlan,
	PlanState,
} from './maintenance.models';
import {
	type MaintenancePlanOutcome,
	MaintenancePlanStore,
} from './maintenance-plan-store';
import { MaintenancePlans } from './maintenance-plans';

const car: MaintenanceCar = { id: 'car-1', name: 'Buggy', archivedAt: null };
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
	name: 'Inspect bearings',
	intervalValue: 1,
	intervalUnit: 'weeks',
	intervalSessions: 4,
	status: 'active',
	dueStatus: 'due',
};

const store = {
	cars: signal<MaintenanceCar[]>([car]),
	plans: signal<MaintenancePlan[]>([plan]),
	timezone: signal('UTC'),
	components: signal([component]),
	action: signal<string | null>(null),
	outcome: signal<MaintenancePlanOutcome>({
		status: 'idle',
		operationId: null,
	}),
	mutate: vi.fn(),
};

type PlanHarness = {
	filter: ReturnType<typeof signal<'all' | PlanState>>;
	mutationError: ReturnType<typeof signal<string>>;
	visiblePlans(): MaintenancePlan[];
	transition(
		plan: MaintenancePlan,
		action: 'pause' | 'resume' | 'archive',
	): void;
	carName(carId: string): string;
	componentName(componentId?: string | null): string;
	isReadOnly(plan: MaintenancePlan): boolean;
	stateLabel(value: PlanState): string;
	filterLabel(value: 'all' | PlanState): string;
	dueText(plan: MaintenancePlan): string;
};

describe('MaintenancePlans', () => {
	let fixture: ComponentFixture<MaintenancePlans>;
	let app: PlanHarness;

	beforeEach(async () => {
		vi.clearAllMocks();
		store.cars.set([car]);
		store.plans.set([plan]);
		store.components.set([component]);
		store.action.set(null);
		store.outcome.set({ status: 'idle', operationId: null });
		await TestBed.configureTestingModule({
			imports: [MaintenancePlans],
			providers: [{ provide: MaintenancePlanStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(MaintenancePlans);
		fixture.detectChanges();
		app = fixture.componentInstance as unknown as PlanHarness;
	});

	it('renders every plan state, total, label, and filter', () => {
		store.plans.set([
			{ ...plan, id: 'overdue', dueStatus: 'overdue' },
			{ ...plan, id: 'due', dueStatus: 'due' },
			{
				...plan,
				id: 'upcoming',
				dueStatus: 'upcoming',
				dateDueAt: '2026-08-12T00:00:00.000Z',
			},
			{ ...plan, id: 'paused', status: 'paused', dueStatus: 'paused' },
			{ ...plan, id: 'archived', status: 'archived', dueStatus: 'archived' },
		]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Overdue');
		expect(fixture.nativeElement.textContent).toContain('Complete');
		expect(fixture.nativeElement.textContent).toContain('Resume');
		expect(app.carName('missing')).toBe('Unknown car');
		expect(app.componentName(null)).toBe('Car-level plan');
		expect(app.componentName('missing')).toBe('Installed component');
		expect(app.stateLabel('upcoming')).toBe('Upcoming');
		expect(app.stateLabel('due')).toBe('Due');
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
				dateDueAt: '2026-08-12T00:00:00.000Z',
			}),
		).toContain('Due Aug 12');
		expect(app.dueText({ ...plan, dueStatus: 'upcoming' })).toBe(
			'Baseline set',
		);

		for (const filter of [
			'overdue',
			'due',
			'upcoming',
			'paused',
			'archived',
			'all',
		] as const) {
			app.filter.set(filter);
			app.visiblePlans();
		}
		expect(app.visiblePlans()).toHaveLength(5);
		store.plans.set([
			{
				...plan,
				intervalValue: 2,
				intervalUnit: null,
				intervalSessions: null,
				dueStatus: 'upcoming',
			},
		]);
		app.filter.set('all');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('every 2 days');
	});

	it('emits semantic editor intents and executes rendered lifecycle controls', () => {
		let created = 0;
		const edited: MaintenancePlan[] = [];
		const completed: MaintenancePlan[] = [];
		fixture.componentInstance.createRequested.subscribe(() => created++);
		fixture.componentInstance.editRequested.subscribe((value) =>
			edited.push(value),
		);
		fixture.componentInstance.completionRequested.subscribe((value) =>
			completed.push(value),
		);
		store.plans.set([
			{ ...plan, id: 'active', dueStatus: 'overdue' },
			{ ...plan, id: 'paused', status: 'paused', dueStatus: 'paused' },
			{ ...plan, id: 'archived', status: 'archived', dueStatus: 'archived' },
		]);
		fixture.detectChanges();
		const button = (
			container: ParentNode,
			label: string,
		): HTMLButtonElement => {
			const found = [...container.querySelectorAll('button')].find(
				(candidate) => candidate.textContent?.trim() === label,
			);
			expect(found).toBeTruthy();
			return found as HTMLButtonElement;
		};

		for (const label of [
			'Overdue',
			'Due',
			'Upcoming',
			'Paused',
			'Archived',
			'Everything',
		]) {
			button(fixture.nativeElement, label).click();
			fixture.detectChanges();
		}
		const active = fixture.nativeElement.querySelector(
			'.plan-overdue',
		) as HTMLElement;
		button(active, 'Edit').click();
		button(active, 'Pause').click();
		button(active, 'Complete').click();
		button(active, 'Archive').click();
		const paused = fixture.nativeElement.querySelector(
			'.plan-paused',
		) as HTMLElement;
		button(paused, 'Resume').click();
		button(paused, 'Archive').click();
		expect(edited).toEqual([expect.objectContaining({ id: 'active' })]);
		expect(completed).toEqual([expect.objectContaining({ id: 'active' })]);
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'transition-plan',
			planId: 'active',
			action: 'pause',
		});

		store.plans.set([]);
		fixture.detectChanges();
		button(fixture.nativeElement, 'Create a plan').click();
		expect(created).toBe(1);
		store.cars.set([{ ...car, archivedAt: '2026-08-01' }]);
		fixture.detectChanges();
		expect(button(fixture.nativeElement, 'Create a plan').disabled).toBe(true);
	});

	it('guards read-only commands and renders transition failures once', () => {
		store.cars.set([{ ...car, archivedAt: '2026-08-01' }]);
		expect(app.isReadOnly(plan)).toBe(true);
		app.transition(plan, 'pause');
		expect(store.mutate).not.toHaveBeenCalled();
		expect(app.isReadOnly({ ...plan, status: 'archived' })).toBe(true);

		store.outcome.set({
			status: 'failed',
			operationId: 1,
			command: { kind: 'transition-plan', planId: 'plan-1', action: 'pause' },
			failure: 'transition-failed',
		});
		fixture.detectChanges();
		expect(app.mutationError()).toContain('could not be saved');
		store.outcome.set({
			status: 'failed',
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
			failure: 'save-failed',
		});
		fixture.detectChanges();
		store.outcome.set({
			status: 'succeeded',
			operationId: 2,
			command: { kind: 'transition-plan', planId: 'plan-1', action: 'resume' },
		});
		fixture.detectChanges();
	});
});
