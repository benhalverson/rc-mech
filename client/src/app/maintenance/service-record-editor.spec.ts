import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	MaintenanceCar,
	MaintenancePlan,
	ServiceRecord,
} from './maintenance.models';
import {
	ServiceRecordEditor,
	type ServiceRecordEditorRequest,
	type ServiceRecordForm,
} from './service-record-editor';
import {
	ServiceRecordStore,
	type ServiceRecordOutcome,
} from './service-record-store';

const car: MaintenanceCar = { id: 'car-1', name: 'Buggy', archivedAt: null };
const component = {
	id: 'component-1',
	carId: 'car-1',
	slot: 'motor',
	name: 'Race motor',
};
const record: ServiceRecord = {
	id: 'record-1',
	carId: 'car-1',
	componentId: 'component-1',
	planId: null,
	performedAt: '2026-08-09T12:30:00.000Z',
	description: 'Inspected bearings',
	notes: 'Measured carefully',
	cost: 12.5,
	currency: 'USD',
};
const plan: MaintenancePlan = {
	id: 'plan-1',
	carId: 'car-1',
	componentId: 'component-1',
	name: 'Inspect bearings',
	status: 'active',
};

const store = {
	cars: signal<MaintenanceCar[]>([car]),
	timezone: signal('UTC'),
	components: signal([component]),
	action: signal<string | null>(null),
	outcome: signal<ServiceRecordOutcome>({ status: 'idle', operationId: null }),
	loadComponents: vi.fn(),
	mutate: vi.fn(),
};

type EditorHarness = {
	form: ReturnType<typeof signal<ServiceRecordForm>>;
	fields: () => {
		invalid(): boolean;
		errorSummary(): Array<{ message?: string }>;
	};
	error: ReturnType<typeof signal<string>>;
	changeCar(event: Event): void;
	save(event: Event): void;
	cancel(): void;
};

describe('ServiceRecordEditor', () => {
	let fixture: ComponentFixture<ServiceRecordEditor>;
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
			imports: [ServiceRecordEditor],
			providers: [{ provide: ServiceRecordStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(ServiceRecordEditor);
		cancelled = 0;
		saved = 0;
		fixture.componentInstance.cancelled.subscribe(() => cancelled++);
		fixture.componentInstance.saved.subscribe(() => saved++);
		fixture.detectChanges();
		app = fixture.componentInstance as unknown as EditorHarness;
	});

	const request = (value: ServiceRecordEditorRequest | null): void => {
		fixture.componentRef.setInput('request', value);
		fixture.detectChanges();
	};

	it('opens create and dispatches one canonical service command', () => {
		expect(fixture.nativeElement.querySelector('form')).toBeNull();
		store.cars.set([car, { ...car, id: 'archived', archivedAt: '2026-08-01' }]);
		request({ kind: 'create' });
		expect(store.loadComponents).toHaveBeenCalledWith('car-1');
		expect(
			[...fixture.nativeElement.querySelectorAll('option')].some(
				(option: HTMLOptionElement) => option.value === 'archived',
			),
		).toBe(false);
		app.form.set({
			carId: 'car-1',
			componentId: 'component-1',
			performedAt: '2026-08-09T12:30',
			description: ' Rebuilt diff ',
			notes: ' Note ',
			cost: '24.5',
			currency: 'cad',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'save-service',
			mode: 'create',
			carId: 'car-1',
			id: null,
			service: {
				performedAt: '2026-08-09T12:30:00.000Z',
				description: 'Rebuilt diff',
				notes: 'Note',
				componentId: 'component-1',
				cost: 24.5,
				currency: 'CAD',
			},
		});

		const select = document.createElement('select');
		select.add(new Option('Second', 'car-2'));
		select.value = 'car-2';
		app.changeCar({ target: select } as unknown as Event);
		expect(store.loadComponents).toHaveBeenCalledWith('car-2');
		app.changeCar(new Event('change'));
	});

	it('focuses every invalid service field and uses validation fallbacks', () => {
		request({ kind: 'create' });
		const submit = (): void => {
			app.save(new Event('submit'));
			fixture.detectChanges();
		};
		app.form.set({ ...app.form(), carId: '', description: 'Work' });
		submit();
		expect(fixture.nativeElement.textContent).toContain('Choose a car');
		app.form.set({ ...app.form(), carId: 'car-1', performedAt: '' });
		submit();
		expect(fixture.nativeElement.textContent).toContain('completion date');
		app.form.set({
			...app.form(),
			performedAt: '2026-08-09T12:30',
			description: '',
		});
		submit();
		expect(fixture.nativeElement.textContent).toContain('completed work');
		app.form.set({ ...app.form(), description: '   ' });
		submit();
		expect(app.error()).toContain('completed work');
		app.form.set({ ...app.form(), description: 'Work', cost: '-1' });
		submit();
		expect(fixture.nativeElement.textContent).toContain('Cost');
		app.form.set({ ...app.form(), cost: '', currency: 'US' });
		submit();
		expect(fixture.nativeElement.textContent).toContain('three-letter');
		app.form.set({ ...app.form(), currency: 'USD', notes: 'x'.repeat(4001) });
		submit();
		expect(fixture.nativeElement.textContent).toContain('4,000');
		Object.defineProperty(app.fields(), 'errorSummary', { value: () => [] });
		app.form.set({ ...app.form(), carId: '' });
		submit();
		expect(app.error()).toBe('Review the service record fields.');
		Object.defineProperty(app.fields(), 'invalid', { value: () => false });
		app.form.set({ ...app.form(), carId: 'car-1', notes: '', cost: '-1' });
		submit();
		expect(app.error()).toContain('Cost');
	});

	it('opens edit defaults and completion requests', () => {
		request({ kind: 'edit', record });
		expect(app.form()).toMatchObject({
			componentId: 'component-1',
			description: 'Inspected bearings',
			cost: '12.5',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({ mode: 'edit', id: 'record-1' }),
		);
		request({
			kind: 'edit',
			record: {
				...record,
				componentId: null,
				notes: null,
				cost: null,
				currency: null,
			},
		});
		expect(app.form()).toMatchObject({
			componentId: '',
			notes: '',
			cost: '',
			currency: 'USD',
		});
		request({ kind: 'complete', plan: { ...plan, componentId: null } });
		expect(app.form()).toMatchObject({
			carId: 'car-1',
			componentId: '',
			description: 'Completed Inspect bearings',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({ mode: 'complete', id: 'plan-1' }),
		);
	});

	it('handles optional payloads, pending saves, and unavailable requests', () => {
		request({ kind: 'create' });
		app.form.set({
			carId: 'car-1',
			componentId: '',
			performedAt: '2026-08-09T12:30',
			description: 'Work',
			notes: '',
			cost: '0',
			currency: '',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				service: expect.objectContaining({
					componentId: undefined,
					cost: 0,
					currency: 'USD',
				}),
			}),
		);
		store.action.set('create');
		store.mutate.mockClear();
		app.save(new Event('submit'));
		expect(store.mutate).not.toHaveBeenCalled();
		store.action.set(null);
		request(null);
		app.save(new Event('submit'));

		store.cars.set([]);
		request({ kind: 'create' });
		expect(cancelled).toBe(1);
		store.cars.set([{ ...car, archivedAt: 'x' }]);
		request({ kind: 'edit', record });
		request({ kind: 'edit', record: { ...record, deletedAt: 'x' } });
		expect(cancelled).toBe(3);
	});

	it('maps presentation-safe save outcomes and closes on success', () => {
		request({ kind: 'create' });
		const saveCommand = {
			kind: 'save-service' as const,
			mode: 'create' as const,
			carId: 'car-1',
			id: null,
			service: { performedAt: record.performedAt, description: 'Work' },
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
			expect(app.error()).toContain(message);
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
			command: { kind: 'undo-activity', recordId: 'record-1' },
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
		expect(saved).toBe(1);
	});

	it('executes rendered form events, labels, and cancellation', () => {
		request({ kind: 'complete', plan });
		for (const [action, label] of [
			['complete', 'Completing…'],
			['edit', 'Saving…'],
			['create', 'Recording…'],
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
		expect(cancelled).toBe(1);
	});
});
