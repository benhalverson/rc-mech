import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	MaintenanceActivity,
	MaintenanceCar,
	MaintenancePlan,
	ServiceRecord,
} from './maintenance.models';
import { ServiceRecords, type ServiceRecordForm } from './service-records';
import {
	ServiceRecordStore,
	type ServiceRecordOutcome,
} from './service-record-store';

const car = { id: 'car-1', name: 'Buggy', archivedAt: null };
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
	records: signal<ServiceRecord[]>([record]),
	activity: signal<MaintenanceActivity[]>([
		{
			id: 'record-1',
			action: 'Scheduled service',
			occurredAt: record.performedAt,
			note: record.description,
		},
	]),
	components: signal([component]),
	action: signal<string | null>(null),
	outcome: signal<ServiceRecordOutcome>({ status: 'idle', operationId: null }),
	loadComponents: vi.fn(),
	mutate: vi.fn(),
};

type ServiceHarness = {
	form: ReturnType<typeof signal<ServiceRecordForm>>;
	fields: () => {
		invalid(): boolean;
		errorSummary(): Array<{ message?: string }>;
	};
	error: ReturnType<typeof signal<string>>;
	mutationError: ReturnType<typeof signal<string>>;
	editing: ReturnType<typeof signal<boolean>>;
	editingId: ReturnType<typeof signal<string | null>>;
	planId: ReturnType<typeof signal<string | null>>;
	historyFilter: ReturnType<typeof signal<string>>;
	visibleRecords(): ServiceRecord[];
	totals(): Array<{ currency: string; total: number }>;
	openCreate(): void;
	openEdit(record: ServiceRecord): void;
	cancelEdit(): void;
	changeCar(event: Event): void;
	setHistoryFilter(value: 'active' | 'deleted'): void;
	save(event: Event): void;
	archive(record: ServiceRecord): void;
	restore(record: ServiceRecord): void;
	undo(item: { id: string; action: string; occurredAt: string }): void;
	isReadOnly(record: ServiceRecord): boolean;
	carName(carId: string): string;
	componentName(record: ServiceRecord): string;
	recordCost(record: ServiceRecord): string;
};

describe('ServiceRecords', () => {
	let fixture: ComponentFixture<ServiceRecords>;
	let app: ServiceHarness;

	beforeEach(async () => {
		vi.clearAllMocks();
		store.cars.set([car]);
		store.records.set([record]);
		store.components.set([component]);
		store.action.set(null);
		store.outcome.set({ status: 'idle', operationId: null });
		await TestBed.configureTestingModule({
			imports: [ServiceRecords],
			providers: [{ provide: ServiceRecordStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(ServiceRecords);
		fixture.detectChanges();
		app = fixture.componentInstance as unknown as ServiceHarness;
	});

	it('renders totals, history, activity, notes, and fallbacks', () => {
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('USD 12.50');
		expect(fixture.nativeElement.textContent).toContain('Measured carefully');
		expect(fixture.nativeElement.textContent).toContain('Scheduled service');
		expect(app.totals()).toEqual([{ currency: 'USD', total: 12.5 }]);
		expect(app.carName('missing')).toBe('Unknown car');
		expect(app.componentName({ ...record, componentId: null })).toBe(
			'Garage service',
		);
		expect(app.componentName({ ...record, componentId: 'missing' })).toBe(
			'Installed component',
		);
		expect(app.recordCost({ ...record, cost: null })).toBe('No cost logged');
		expect(app.recordCost({ ...record, currency: null })).toBe('USD 12.50');
		store.records.set([
			record,
			{ ...record, id: 'no-cost', cost: null, notes: null },
			{ ...record, id: 'usd-default', cost: 2, currency: null },
		]);
		expect(app.totals()).toEqual([{ currency: 'USD', total: 14.5 }]);

		store.records.set([{ ...record, deletedAt: '2026-08-10' }]);
		app.setHistoryFilter('deleted');
		fixture.detectChanges();
		expect(app.visibleRecords()).toHaveLength(1);
		expect(fixture.nativeElement.textContent).toContain('Archived');
		app.setHistoryFilter('active');
		expect(app.visibleRecords()).toEqual([]);
	});

	it('owns create validation and dispatches one service command', () => {
		app.openCreate();
		expect(store.loadComponents).toHaveBeenCalledWith('car-1');
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

		app.form.set({ ...app.form(), description: '', cost: '-1' });
		app.save(new Event('submit'));
		expect(app.error()).toBeTruthy();
		Object.defineProperty(app.fields(), 'invalid', { value: () => false });
		app.save(new Event('submit'));
		expect(app.error()).toContain('Cost');
	});

	it('focuses each invalid service field and uses the validation fallback', () => {
		app.openCreate();
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
		expect(fixture.nativeElement.textContent).toContain('completed work');
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
	});

	it('edits records, guards read-only rows, and loads selected-car components', () => {
		app.openEdit(record);
		expect(app.form()).toMatchObject({
			carId: 'car-1',
			description: 'Inspected bearings',
			cost: '12.5',
		});
		app.form.set({ ...app.form(), cost: '', notes: '', componentId: '' });
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				mode: 'edit',
				id: 'record-1',
				service: {
					performedAt: '2026-08-09T12:30:00.000Z',
					description: 'Inspected bearings',
					componentId: undefined,
				},
			}),
		);
		app.cancelEdit();
		app.openEdit({
			id: 'minimal',
			carId: 'car-1',
			componentId: null,
			planId: null,
			performedAt: record.performedAt,
			description: 'Minimal',
			cost: null,
			currency: null,
			notes: null,
		});
		expect(app.form()).toMatchObject({
			componentId: '',
			notes: '',
			cost: '',
			currency: 'USD',
		});
		app.cancelEdit();

		const select = document.createElement('select');
		select.add(new Option('Second', 'car-2'));
		select.value = 'car-2';
		app.changeCar({ target: select } as unknown as Event);
		expect(store.loadComponents).toHaveBeenCalledWith('car-2');
		app.changeCar(new Event('change'));

		store.cars.set([{ ...car, archivedAt: '2026-08-01' }]);
		expect(app.isReadOnly(record)).toBe(true);
		app.openEdit(record);
		app.archive(record);
		expect(app.isReadOnly({ ...record, deletedAt: '2026-08-01' })).toBe(true);
		app.cancelEdit();
		store.cars.set([]);
		app.openCreate();
		expect(app.editing()).toBe(false);
	});

	it('defaults optional currency and suppresses a pending service save', () => {
		app.openCreate();
		app.form.set({
			carId: 'car-1',
			componentId: '',
			performedAt: '2026-08-09T12:30',
			description: ' Work ',
			notes: '',
			cost: '0',
			currency: '',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith({
			kind: 'save-service',
			mode: 'create',
			carId: 'car-1',
			id: null,
			service: {
				performedAt: '2026-08-09T12:30:00.000Z',
				description: 'Work',
				componentId: undefined,
				cost: 0,
				currency: 'USD',
			},
		});
		store.action.set('create');
		store.mutate.mockClear();
		app.save(new Event('submit'));
		expect(store.mutate).not.toHaveBeenCalled();
	});

	it('opens a typed plan completion and emits when it closes', () => {
		let closed = 0;
		fixture.componentInstance.completionClosed.subscribe(() => closed++);
		fixture.componentRef.setInput('completionPlan', plan);
		fixture.detectChanges();
		expect(app.editing()).toBe(true);
		expect(app.planId()).toBe('plan-1');
		expect(app.form().description).toBe('Completed Inspect bearings');
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenCalledWith(
			expect.objectContaining({ mode: 'complete', id: 'plan-1' }),
		);
		app.cancelEdit();
		expect(closed).toBe(1);
		fixture.componentRef.setInput('completionPlan', null);
		fixture.detectChanges();
	});

	it('dispatches archive, restore, and undo while suppressing pending work', () => {
		app.archive(record);
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'change-service',
			recordId: 'record-1',
			action: 'archive',
		});
		app.restore({ ...record, deletedAt: '2026-08-10' });
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'change-service',
			recordId: 'record-1',
			action: 'restore',
		});
		app.undo({ id: 'record-1', action: 'Completed', occurredAt: '2026-08-09' });
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'undo-activity',
			recordId: 'record-1',
		});

		store.action.set('create');
		store.mutate.mockClear();
		app.archive(record);
		app.restore(record);
		expect(store.mutate).not.toHaveBeenCalled();
	});

	it('maps every outcome kind and closes successful saves', () => {
		app.openCreate();
		const saveCommand = {
			kind: 'save-service' as const,
			mode: 'create' as const,
			carId: 'car-1',
			id: null,
			service: {
				performedAt: '2026-08-09T12:30:00.000Z',
				description: 'Work',
			},
		};
		store.outcome.set({
			status: 'failed',
			operationId: 1,
			command: saveCommand,
			error: { kind: 'http', status: 409 },
		});
		fixture.detectChanges();
		expect(app.error()).toContain('archived');
		store.outcome.set({
			status: 'failed',
			operationId: 2,
			command: saveCommand,
			error: { kind: 'http', status: 401 },
		});
		fixture.detectChanges();
		expect(app.error()).toContain('session has expired');
		store.outcome.set({
			status: 'failed',
			operationId: 3,
			command: saveCommand,
			error: { kind: 'unavailable' },
		});
		fixture.detectChanges();
		expect(app.error()).toContain('could not be saved');
		store.outcome.set({
			status: 'failed',
			operationId: 4,
			command: {
				kind: 'change-service',
				recordId: 'record-1',
				action: 'archive',
			},
			error: { kind: 'unavailable' },
		});
		fixture.detectChanges();
		expect(app.error()).toContain('could not be archived');
		store.outcome.set({
			status: 'failed',
			operationId: 5,
			command: {
				kind: 'change-service',
				recordId: 'record-1',
				action: 'restore',
			},
			error: { kind: 'unavailable' },
		});
		fixture.detectChanges();
		expect(app.error()).toContain('could not be restored');
		store.outcome.set({
			status: 'failed',
			operationId: 6,
			command: { kind: 'undo-activity', recordId: 'record-1' },
			error: { kind: 'unavailable' },
		});
		fixture.detectChanges();
		expect(app.mutationError()).toContain('could not be undone');
		store.outcome.set({
			status: 'succeeded',
			operationId: 7,
			command: saveCommand,
		});
		fixture.detectChanges();
		expect(app.editing()).toBe(false);
		store.outcome.set({
			status: 'succeeded',
			operationId: 8,
			command: {
				kind: 'change-service',
				recordId: 'record-1',
				action: 'archive',
			},
		});
		fixture.detectChanges();
	});

	it('renders a non-editor service action failure', () => {
		store.outcome.set({
			status: 'failed',
			operationId: 1,
			command: {
				kind: 'change-service',
				recordId: 'record-1',
				action: 'archive',
			},
			error: { kind: 'unavailable' },
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'could not be archived',
		);
	});

	it('executes every rendered service control', () => {
		store.records.set([
			{ ...record, planId: 'plan-1' },
			{ ...record, id: 'ad-hoc', planId: null, notes: null, cost: null },
			{ ...record, id: 'deleted', deletedAt: '2026-08-10' },
		]);
		store.activity.set([
			{
				id: 'activity-note',
				action: 'Completed',
				occurredAt: record.performedAt,
				note: 'Looked good',
			},
			{
				id: 'activity-plain',
				action: 'Reset baseline',
				occurredAt: record.performedAt,
			},
		]);
		store.cars.set([
			car,
			{ ...car, id: 'archived-car', archivedAt: '2026-08-01' },
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

		button(fixture.nativeElement, 'Log ad hoc service').click();
		fixture.detectChanges();
		expect(
			[...fixture.nativeElement.querySelectorAll('form option')].some(
				(option: HTMLOptionElement) => option.value === 'archived-car',
			),
		).toBe(false);
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
		expect(app.error()).toBeTruthy();
		button(fixture.nativeElement, 'Cancel').click();
		fixture.detectChanges();

		button(fixture.nativeElement, 'Archived corrections').click();
		fixture.detectChanges();
		button(fixture.nativeElement, 'Undo').click();
		button(fixture.nativeElement, 'Current ledger').click();
		fixture.detectChanges();
		button(fixture.nativeElement, 'Correct').click();
		fixture.detectChanges();
		button(fixture.nativeElement, 'Cancel').click();
		fixture.detectChanges();
		button(fixture.nativeElement, 'Archive').click();
		button(fixture.nativeElement, 'Undo completion').click();

		store.records.set([]);
		store.activity.set([]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'No service recorded yet',
		);
		expect(fixture.nativeElement.textContent).toContain(
			'Completed plans and baseline changes',
		);
		button(fixture.nativeElement, 'Archived corrections').click();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'No archived service records',
		);
	});
});
