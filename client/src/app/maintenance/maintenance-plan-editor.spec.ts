import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceCar, MaintenancePlan } from './maintenance.models';
import {
	MaintenancePlanEditor,
	type MaintenancePlanEditorRequest,
	type MaintenancePlanForm,
} from './maintenance-plan-editor';
import {
	type MaintenancePlanOutcome,
	MaintenancePlanStore,
} from './maintenance-plan-store';

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
	intervalDays: 7,
	intervalValue: 1,
	intervalUnit: 'weeks',
	intervalSessions: 4,
	baselineAt: '2026-08-01T00:00:00.000Z',
	baselineSessionCount: 2,
	status: 'active',
};

const store = {
	cars: signal<MaintenanceCar[]>([car]),
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

type EditorHarness = {
	form: ReturnType<typeof signal<MaintenancePlanForm>>;
	fields: () => {
		invalid(): boolean;
		errorSummary(): Array<{ message?: string }>;
	};
	formError: ReturnType<typeof signal<string>>;
	changeCar(event: Event): void;
	save(event: Event): void;
	cancel(): void;
};

describe('MaintenancePlanEditor', () => {
	let fixture: ComponentFixture<MaintenancePlanEditor>;
	let app: EditorHarness;
	let cancelled: number;
	let saved: number;

	beforeEach(async () => {
		vi.clearAllMocks();
		store.cars.set([car]);
		store.components.set([component]);
		store.action.set(null);
		store.outcome.set({ status: 'idle', operationId: null });
		await TestBed.configureTestingModule({
			imports: [MaintenancePlanEditor],
			providers: [{ provide: MaintenancePlanStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(MaintenancePlanEditor);
		cancelled = 0;
		saved = 0;
		fixture.componentInstance.cancelled.subscribe(() => cancelled++);
		fixture.componentInstance.saved.subscribe(() => saved++);
		fixture.detectChanges();
		app = fixture.componentInstance as unknown as EditorHarness;
	});

	const request = (value: MaintenancePlanEditorRequest | null): void => {
		fixture.componentRef.setInput('request', value);
		fixture.detectChanges();
	};
	const control = (label: string): HTMLElement => {
		const match = [...fixture.nativeElement.querySelectorAll('label')].find(
			(candidate: HTMLLabelElement) =>
				candidate.querySelector('span')?.textContent?.trim() === label,
		) as HTMLLabelElement | undefined;
		expect(match).toBeTruthy();
		return match?.querySelector('input, select, textarea') as HTMLElement;
	};

	it('opens create, owns the form, focuses it, and dispatches a canonical command', async () => {
		expect(fixture.nativeElement.querySelector('form')).toBeNull();
		store.cars.set([car, { ...car, id: 'archived', archivedAt: '2026-08-01' }]);
		request({ kind: 'create' });
		await fixture.whenStable();
		expect(document.activeElement).toBe(
			fixture.nativeElement.querySelector('#maintenance-form-title'),
		);
		expect(store.loadComponents).toHaveBeenCalledWith('car-1');
		expect(
			[...fixture.nativeElement.querySelectorAll('option')].some(
				(option: HTMLOptionElement) => option.value === 'archived',
			),
		).toBe(false);
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

		const select = document.createElement('select');
		select.add(new Option('Second', 'car-2'));
		select.value = 'car-2';
		app.changeCar({ target: select } as unknown as Event);
		expect(store.loadComponents).toHaveBeenCalledWith('car-2');
		app.changeCar(new Event('change'));
	});

	it('focuses each invalid field and covers interval guards', () => {
		request({ kind: 'create' });
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
		expect(document.activeElement).toBe(control('Car'));
		app.form.set({ ...app.form(), carId: 'car-1', name: '' });
		submit();
		expect(fixture.nativeElement.textContent).toContain('Name the care rule');
		expect(document.activeElement).toBe(control('Plan name'));
		app.form.set({ ...app.form(), name: '   ' });
		submit();
		expect(app.formError()).toContain('Name the care rule');
		expect(document.activeElement).toBe(control('Plan name'));
		app.form.set({ ...app.form(), name: 'Plan', calendarValue: 'half' });
		submit();
		expect(fixture.nativeElement.textContent).toContain('whole numbers');
		expect(document.activeElement).toBe(control('Calendar interval'));
		app.form.set({ ...app.form(), calendarValue: '', sessionInterval: '0' });
		submit();
		expect(fixture.nativeElement.textContent).toContain('at least one');
		expect(document.activeElement).toBe(control('Drive-session threshold'));
		app.form.set({
			...app.form(),
			sessionInterval: '1',
			baselineSessions: 'half',
		});
		submit();
		expect(fixture.nativeElement.textContent).toContain('Prior sessions');
		expect(document.activeElement).toBe(control('Prior drive sessions'));
		Object.defineProperty(app.fields(), 'errorSummary', { value: () => [] });
		app.form.set({ ...app.form(), carId: '' });
		submit();
		expect(app.formError()).toBe('Review the maintenance plan fields.');
		expect(document.activeElement).toBe(control('Car'));
		Object.defineProperty(app.fields(), 'invalid', { value: () => false });
		app.form.set({
			...app.form(),
			carId: 'car-1',
			baselineSessions: '0',
			sessionInterval: '1.5',
		});
		submit();
		expect(app.formError()).toContain('whole numbers greater than zero');
		app.form.set({ ...app.form(), calendarValue: '', sessionInterval: '' });
		submit();
		expect(app.formError()).toContain('calendar interval');
	});

	it('opens all persisted edit shapes and sends optional day values', () => {
		request({ kind: 'edit', plan });
		expect(app.form()).toMatchObject({
			calendarValue: '1',
			calendarUnit: 'weeks',
			sessionInterval: '4',
		});
		request({
			kind: 'edit',
			plan: {
				...plan,
				componentId: null,
				intervalUnit: 'none',
				intervalValue: null,
				intervalDays: null,
				intervalSessions: null,
				baselineAt: null,
				baselineSessionCount: null,
			},
		});
		expect(app.form()).toMatchObject({
			componentId: '',
			calendarValue: '',
			sessionInterval: '',
			baselineAt: '',
			baselineSessions: '0',
		});
		request({
			kind: 'edit',
			plan: { ...plan, intervalValue: null, intervalDays: 10 },
		});
		expect(app.form().calendarValue).toBe('10');
		request({
			kind: 'edit',
			plan: { ...plan, intervalValue: null, intervalDays: null },
		});
		expect(app.form().calendarValue).toBe('');

		request({ kind: 'create' });
		app.form.set({
			carId: 'car-1',
			componentId: '',
			name: 'Daily check',
			calendarValue: '1',
			calendarUnit: 'days',
			sessionInterval: '',
			baselineAt: '',
			baselineSessions: '',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				plan: expect.objectContaining({
					componentId: undefined,
					intervalDays: 1,
					baselineAt: undefined,
					baselineSessionCount: 0,
				}),
			}),
		);
		app.form.set({
			...app.form(),
			calendarValue: '',
			sessionInterval: '5',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				plan: expect.objectContaining({
					intervalUnit: 'none',
					intervalValue: 1,
					intervalSessions: 5,
				}),
			}),
		);
		store.action.set('create');
		store.mutate.mockClear();
		app.save(new Event('submit'));
		expect(store.mutate).not.toHaveBeenCalled();
	});

	it('rejects unavailable and read-only requests and emits cancellation', () => {
		store.cars.set([]);
		request({ kind: 'create' });
		expect(cancelled).toBe(1);
		store.cars.set([{ ...car, archivedAt: '2026-08-01' }]);
		request({ kind: 'edit', plan });
		request({ kind: 'edit', plan: { ...plan, status: 'archived' } });
		expect(cancelled).toBe(3);
		request(null);
		app.form.set({
			carId: 'car-1',
			componentId: '',
			name: 'No request',
			calendarValue: '1',
			calendarUnit: 'days',
			sessionInterval: '',
			baselineAt: '',
			baselineSessions: '0',
		});
		app.save(new Event('submit'));
	});

	it('maps presentation-safe outcomes, closes successful saves, and restores focus', async () => {
		const focusTarget = document.createElement('h2');
		focusTarget.id = 'maintenance-title';
		focusTarget.tabIndex = -1;
		document.body.append(focusTarget);
		request({ kind: 'create' });
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
		for (const [operationId, failure, message] of [
			[1, 'session-expired', 'session has expired'],
			[2, 'car-archived', 'car is archived'],
			[3, 'save-failed', 'could not be saved'],
		] as const) {
			store.outcome.set({
				status: 'failed',
				operationId,
				command: saveCommand,
				failure,
			});
			fixture.detectChanges();
			expect(app.formError()).toContain(message);
		}
		store.outcome.set({
			status: 'failed',
			operationId: 3,
			command: saveCommand,
			failure: 'save-failed',
		});
		fixture.detectChanges();
		store.outcome.set({
			status: 'succeeded',
			operationId: 4,
			command: { kind: 'transition-plan', planId: 'plan-1', action: 'pause' },
		});
		fixture.detectChanges();
		store.outcome.set({
			status: 'pending',
			operationId: 5,
			command: saveCommand,
		});
		fixture.detectChanges();
		store.outcome.set({
			status: 'succeeded',
			operationId: 5,
			command: saveCommand,
		});
		fixture.detectChanges();
		await fixture.whenStable();
		expect(saved).toBe(1);
		expect(document.activeElement).toBe(focusTarget);
		focusTarget.remove();
	});

	it('executes rendered form events, pending labels, and cancel focus', async () => {
		const focusTarget = document.createElement('button');
		focusTarget.dataset['maintenanceLauncher'] = 'plan:plan-1';
		document.body.append(focusTarget);
		request({ kind: 'edit', plan });
		for (const [action, label] of [
			['edit', 'Saving…'],
			['create', 'Creating…'],
		] as const) {
			store.action.set(action);
			fixture.detectChanges();
			expect(fixture.nativeElement.textContent).toContain(label);
		}
		store.action.set(null);
		fixture.detectChanges();
		const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
		const select = form.querySelector('select') as HTMLSelectElement;
		select.add(new Option('Second', 'car-2'));
		select.value = 'car-2';
		select.dispatchEvent(new Event('change'));
		form.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		const cancel = [...form.querySelectorAll('button')].find(
			(button) => button.textContent?.trim() === 'Cancel',
		) as HTMLButtonElement;
		cancel.click();
		await fixture.whenStable();
		expect(cancelled).toBe(1);
		expect(document.activeElement).toBe(focusTarget);
		focusTarget.remove();
	});
});
