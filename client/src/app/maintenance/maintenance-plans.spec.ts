import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	MaintenancePlans,
	type MaintenancePlanForm,
} from './maintenance-plans';
import {
	MaintenancePlanStore,
	type MaintenancePlanOutcome,
} from './maintenance-plan-store';
import type { MaintenanceCar, MaintenancePlan } from './maintenance.models';

const car = { id: 'car-1', name: 'Buggy', archivedAt: null };
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
	intervalDays: 7,
	intervalValue: 1,
	intervalUnit: 'weeks',
	intervalSessions: 4,
	baselineAt: '2026-08-01T00:00:00.000Z',
	baselineSessionCount: 2,
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
	loadComponents: vi.fn(),
	mutate: vi.fn(),
};

type PlanHarness = {
	form: ReturnType<typeof signal<MaintenancePlanForm>>;
	fields: () => {
		invalid(): boolean;
		errorSummary(): Array<{ message?: string }>;
	};
	formError: ReturnType<typeof signal<string>>;
	mutationError: ReturnType<typeof signal<string>>;
	editing: ReturnType<typeof signal<boolean>>;
	selectedFilter: ReturnType<typeof signal<string>>;
	visiblePlans(): MaintenancePlan[];
	openCreate(): void;
	openEdit(plan: MaintenancePlan): void;
	cancelEdit(): void;
	changeCar(event: Event): void;
	setFilter(value: string): void;
	save(event: Event): void;
	transition(
		plan: MaintenancePlan,
		action: 'pause' | 'resume' | 'archive',
	): void;
	complete(plan: MaintenancePlan): void;
	carName(carId: string): string;
	componentName(componentId?: string | null): string;
	isReadOnly(plan: MaintenancePlan): boolean;
	stateLabel(value: string): string;
	filterLabel(value: string): string;
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

	it('renders plan totals, filters, labels, and lifecycle controls', () => {
		store.plans.set([
			{ ...plan, id: 'overdue', dueStatus: 'overdue' },
			{ ...plan, id: 'due', dueStatus: 'due' },
			{ ...plan, id: 'upcoming', dueStatus: 'upcoming' },
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
		expect(app.dueText({ ...plan, dueStatus: 'overdue' })).toBe(
			'Needs attention',
		);
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
		]) {
			app.setFilter(filter);
			app.visiblePlans();
		}
		expect(app.visiblePlans()).toHaveLength(5);
	});

	it('owns create validation and dispatches one canonical save command', () => {
		app.openCreate();
		expect(store.loadComponents).toHaveBeenCalledWith('car-1');
		app.form.set({
			carId: 'car-1',
			componentId: 'component-1',
			name: ' Inspect ',
			calendarValue: '2',
			calendarUnit: 'weeks',
			sessionInterval: '',
			baselineAt: '2026-08-09T12:30',
			baselineSessions: '3',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'save-plan',
			mode: 'create',
			id: null,
			plan: {
				carId: 'car-1',
				componentId: 'component-1',
				name: 'Inspect',
				intervalUnit: 'weeks',
				intervalValue: 2,
				intervalSessions: undefined,
				baselineAt: '2026-08-09T12:30:00.000Z',
				baselineSessionCount: 3,
			},
		});

		app.form.set({ ...app.form(), name: ' ', calendarValue: '' });
		app.save(new Event('submit'));
		expect(app.formError()).toBeTruthy();
		Object.defineProperty(app.fields(), 'invalid', { value: () => false });
		app.form.set({ ...app.form(), name: 'Plan', calendarValue: '1.5' });
		app.save(new Event('submit'));
		expect(app.formError()).toContain('whole numbers');
		app.form.set({ ...app.form(), calendarValue: '', sessionInterval: '' });
		app.save(new Event('submit'));
		expect(app.formError()).toContain('calendar interval');
	});

	it('focuses each invalid plan field and uses the validation fallback', () => {
		app.openCreate();
		const submit = (): void => {
			app.save(new Event('submit'));
			fixture.detectChanges();
		};

		app.form.set({
			...app.form(),
			carId: '',
			name: 'Plan',
			calendarValue: '1',
		});
		submit();
		expect(fixture.nativeElement.textContent).toContain('Choose a car');
		app.form.set({ ...app.form(), carId: 'car-1', name: '' });
		submit();
		expect(fixture.nativeElement.textContent).toContain('Name the care rule');
		app.form.set({ ...app.form(), name: 'Plan', calendarValue: 'half' });
		submit();
		expect(fixture.nativeElement.textContent).toContain('whole numbers');
		app.form.set({ ...app.form(), calendarValue: '', sessionInterval: '0' });
		submit();
		expect(fixture.nativeElement.textContent).toContain('at least one');
		app.form.set({
			...app.form(),
			sessionInterval: '1',
			baselineSessions: 'half',
		});
		submit();
		expect(fixture.nativeElement.textContent).toContain('Prior sessions');

		Object.defineProperty(app.fields(), 'errorSummary', { value: () => [] });
		app.form.set({ ...app.form(), carId: '' });
		submit();
		expect(app.formError()).toBe('Review the maintenance plan fields.');
	});

	it('edits persisted interval forms and guards archived plans and cars', () => {
		app.openEdit(plan);
		expect(app.form()).toMatchObject({
			carId: 'car-1',
			calendarValue: '1',
			calendarUnit: 'weeks',
			sessionInterval: '4',
		});
		app.form.set({ ...app.form(), calendarValue: '', sessionInterval: '5' });
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				mode: 'edit',
				id: 'plan-1',
				plan: expect.objectContaining({
					intervalUnit: 'none',
					intervalValue: 1,
					intervalSessions: 5,
				}),
			}),
		);

		app.cancelEdit();
		app.openEdit({ ...plan, intervalUnit: 'none', intervalValue: null });
		expect(app.form().calendarValue).toBe('');
		app.cancelEdit();
		app.openEdit({ ...plan, intervalValue: null, intervalDays: 10 });
		expect(app.form().calendarValue).toBe('10');
		app.cancelEdit();
		app.openEdit({
			...plan,
			componentId: null,
			intervalValue: null,
			intervalDays: null,
			intervalSessions: null,
			baselineAt: null,
			baselineSessionCount: null,
		});
		expect(app.form()).toMatchObject({
			componentId: '',
			calendarValue: '',
			sessionInterval: '',
			baselineAt: '',
			baselineSessions: '0',
		});

		store.cars.set([{ ...car, archivedAt: '2026-08-01' }]);
		expect(app.isReadOnly(plan)).toBe(true);
		app.openEdit(plan);
		app.transition(plan, 'pause');
		expect(store.mutate).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'transition-plan' }),
		);
		expect(app.isReadOnly({ ...plan, status: 'archived' })).toBe(true);
		app.cancelEdit();
		app.openCreate();
		expect(app.editing()).toBe(false);
	});

	it('covers optional save values and suppresses duplicate plan commands', () => {
		app.openCreate();
		app.form.set({
			carId: 'car-1',
			componentId: '',
			name: ' Daily check ',
			calendarValue: '1',
			calendarUnit: 'days',
			sessionInterval: '',
			baselineAt: '',
			baselineSessions: '',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith({
			kind: 'save-plan',
			mode: 'create',
			id: null,
			plan: {
				carId: 'car-1',
				componentId: undefined,
				name: 'Daily check',
				intervalUnit: 'days',
				intervalValue: 1,
				intervalDays: 1,
				intervalSessions: undefined,
				baselineAt: undefined,
				baselineSessionCount: 0,
			},
		});
		store.action.set('create');
		store.mutate.mockClear();
		app.save(new Event('submit'));
		expect(store.mutate).not.toHaveBeenCalled();
	});

	it('loads selected-car components and emits completion intent', () => {
		const completed: MaintenancePlan[] = [];
		fixture.componentInstance.completePlan.subscribe((value) =>
			completed.push(value),
		);
		const select = document.createElement('select');
		select.add(new Option('Second', 'car-2'));
		select.value = 'car-2';
		app.changeCar({ target: select } as unknown as Event);
		expect(store.loadComponents).toHaveBeenCalledWith('car-2');
		app.changeCar(new Event('change'));

		app.complete(plan);
		expect(completed).toEqual([plan]);
		app.complete({ ...plan, status: 'archived' });
		expect(completed).toEqual([plan]);
		app.transition(plan, 'pause');
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'transition-plan',
			planId: 'plan-1',
			action: 'pause',
		});
	});

	it('opens from a coordinator create request', () => {
		fixture.componentRef.setInput('createRequested', true);
		fixture.detectChanges();
		expect(app.editing()).toBe(true);
		expect(store.loadComponents).toHaveBeenCalledWith('car-1');
	});

	it('maps typed outcomes and closes a successful editor', () => {
		app.openCreate();
		const saveCommand = {
			kind: 'save-plan' as const,
			mode: 'create' as const,
			id: null,
			plan: {
				carId: 'car-1',
				name: 'Plan',
				intervalUnit: 'days' as const,
				intervalValue: 1,
				baselineSessionCount: 0,
			},
		};
		store.outcome.set({
			status: 'failed',
			operationId: 1,
			command: saveCommand,
			error: { kind: 'http', status: 401 },
		});
		fixture.detectChanges();
		expect(app.formError()).toContain('session has expired');
		store.outcome.set({
			status: 'failed',
			operationId: 2,
			command: saveCommand,
			error: { kind: 'http', status: 409 },
		});
		fixture.detectChanges();
		expect(app.formError()).toContain('archived');
		store.outcome.set({
			status: 'failed',
			operationId: 3,
			command: saveCommand,
			error: { kind: 'unavailable' },
		});
		fixture.detectChanges();
		expect(app.formError()).toContain('could not be saved');
		store.outcome.set({
			status: 'failed',
			operationId: 4,
			command: {
				kind: 'transition-plan',
				planId: 'plan-1',
				action: 'pause',
			},
			error: { kind: 'unavailable' },
		});
		fixture.detectChanges();
		expect(app.mutationError()).toContain('could not be saved');
		store.outcome.set({
			status: 'succeeded',
			operationId: 5,
			command: saveCommand,
		});
		fixture.detectChanges();
		expect(app.editing()).toBe(false);
		store.outcome.set({
			status: 'succeeded',
			operationId: 6,
			command: {
				kind: 'transition-plan',
				planId: 'plan-1',
				action: 'resume',
			},
		});
		fixture.detectChanges();
	});

	it('executes every rendered plan control', () => {
		store.plans.set([
			{ ...plan, id: 'active', dueStatus: 'overdue' },
			{
				...plan,
				id: 'due',
				dueStatus: 'due',
				intervalUnit: null,
				intervalSessions: null,
			},
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
		fixture.detectChanges();
		store.action.set('edit');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Saving…');
		store.action.set(null);
		fixture.detectChanges();
		button(fixture.nativeElement, 'Cancel').click();
		fixture.detectChanges();

		const refreshedActive = fixture.nativeElement.querySelector(
			'.plan-overdue',
		) as HTMLElement;
		button(refreshedActive, 'Pause').click();
		button(refreshedActive, 'Complete').click();
		button(refreshedActive, 'Archive').click();
		app.setFilter('all');
		fixture.detectChanges();
		const paused = fixture.nativeElement.querySelector(
			'.plan-paused',
		) as HTMLElement;
		button(paused, 'Resume').click();
		button(paused, 'Archive').click();

		store.plans.set([]);
		store.cars.set([
			car,
			{ ...car, id: 'archived-car', archivedAt: '2026-08-01' },
		]);
		fixture.detectChanges();
		button(fixture.nativeElement, 'Create a plan').click();
		fixture.detectChanges();
		expect(
			[...fixture.nativeElement.querySelectorAll('form option')].some(
				(option: HTMLOptionElement) => option.value === 'archived-car',
			),
		).toBe(false);
		store.action.set('create');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Creating…');
		store.action.set(null);
		fixture.detectChanges();
		const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
		const select = form.querySelector('select') as HTMLSelectElement;
		select.add(new Option('Second', 'car-2'));
		select.value = 'car-2';
		select.dispatchEvent(new Event('change'));
		form.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(app.formError()).toBeTruthy();
	});
});
