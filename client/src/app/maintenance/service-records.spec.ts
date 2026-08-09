import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	MaintenanceActivity,
	MaintenanceCar,
	ServiceRecord,
} from './maintenance.models';
import {
	type ServiceRecordOutcome,
	ServiceRecordStore,
} from './service-record-store';
import { ServiceRecords } from './service-records';

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
	planId: 'plan-1',
	performedAt: '2026-08-09T12:30:00.000Z',
	description: 'Inspected bearings',
	notes: 'Measured carefully',
	cost: 12.5,
	currency: 'USD',
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
	mutate: vi.fn(),
};

type ServiceHarness = {
	filter: ReturnType<typeof signal<'active' | 'deleted'>>;
	error: ReturnType<typeof signal<string>>;
	visibleRecords(): ServiceRecord[];
	archive(record: ServiceRecord): void;
	restore(record: ServiceRecord): void;
	undo(item: MaintenanceActivity): void;
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
		store.activity.set([
			{
				id: 'record-1',
				action: 'Scheduled service',
				occurredAt: record.performedAt,
				note: record.description,
			},
		]);
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

	it('renders history, activity, notes, costs, and lookup fallbacks', () => {
		expect(fixture.nativeElement.textContent).toContain('Measured carefully');
		expect(fixture.nativeElement.textContent).toContain('Scheduled service');
		expect(app.carName('missing')).toBe('Unknown car');
		expect(app.componentName({ ...record, componentId: null })).toBe(
			'Garage service',
		);
		expect(app.componentName({ ...record, componentId: 'missing' })).toBe(
			'Installed component',
		);
		expect(app.componentName(record)).toBe('Race motor');
		expect(app.recordCost({ ...record, cost: null })).toBe('No cost logged');
		expect(app.recordCost({ ...record, currency: null })).toBe('USD 12.50');

		store.records.set([
			record,
			{ ...record, id: 'ad-hoc', planId: null, notes: null, cost: null },
			{ ...record, id: 'deleted', deletedAt: '2026-08-10' },
		]);
		store.activity.set([
			...store.activity(),
			{
				id: 'plain',
				action: 'Reset baseline',
				occurredAt: record.performedAt,
			},
		]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Ad hoc service');
		app.filter.set('deleted');
		fixture.detectChanges();
		expect(app.visibleRecords()).toHaveLength(1);
		expect(fixture.nativeElement.textContent).toContain('Archived');
		store.records.set([]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'No archived service records',
		);
		app.filter.set('active');
		store.activity.set([]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'No service recorded yet',
		);
		expect(fixture.nativeElement.textContent).toContain(
			'Completed plans and baseline changes',
		);
	});

	it('emits edit intent and executes archive, restore, and undo controls', () => {
		const edited: ServiceRecord[] = [];
		fixture.componentInstance.editRequested.subscribe((value) =>
			edited.push(value),
		);
		store.records.set([record, { ...record, id: 'deleted', deletedAt: 'x' }]);
		fixture.detectChanges();
		const button = (label: string): HTMLButtonElement => {
			const found = [...fixture.nativeElement.querySelectorAll('button')].find(
				(candidate: HTMLButtonElement) =>
					candidate.textContent?.trim() === label,
			);
			expect(found).toBeTruthy();
			return found as HTMLButtonElement;
		};
		button('Correct').click();
		button('Archive').click();
		button('Undo completion').click();
		expect(edited).toEqual([record]);
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'change-service',
			recordId: 'record-1',
			action: 'archive',
		});
		button('Archived corrections').click();
		fixture.detectChanges();
		button('Undo').click();
		button('Current ledger').click();
		fixture.detectChanges();
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'change-service',
			recordId: 'deleted',
			action: 'restore',
		});

		store.action.set('create');
		fixture.detectChanges();
		expect(button('Correct').disabled).toBe(true);
		expect(button('Archive').disabled).toBe(true);
		expect(button('Undo completion').disabled).toBe(true);
		store.mutate.mockClear();
		app.archive(record);
		app.restore(record);
		expect(store.mutate).not.toHaveBeenCalled();
		store.action.set(null);
		store.cars.set([{ ...car, archivedAt: 'x' }]);
		expect(app.isReadOnly(record)).toBe(true);
		app.archive(record);
		expect(app.isReadOnly({ ...record, deletedAt: 'x' })).toBe(true);
	});

	it('maps archive and restore failures once and ignores other outcomes', () => {
		for (const [operationId, failure, message, command] of [
			[
				1,
				'archive-failed',
				'could not be archived',
				{ kind: 'change-service', recordId: 'record-1', action: 'archive' },
			],
			[
				2,
				'restore-failed',
				'could not be restored',
				{ kind: 'change-service', recordId: 'record-1', action: 'restore' },
			],
		] as const) {
			store.outcome.set({
				status: 'failed',
				operationId,
				command,
				failure,
			});
			fixture.detectChanges();
			expect(app.error()).toContain(message);
		}
		store.outcome.set({
			status: 'failed',
			operationId: 2,
			command: { kind: 'undo-activity', recordId: 'record-1' },
			failure: 'undo-failed',
		});
		fixture.detectChanges();
		store.outcome.set({
			status: 'failed',
			operationId: 3,
			command: {
				kind: 'save-service',
				mode: 'create',
				carId: 'car-1',
				id: null,
				service: { performedAt: record.performedAt, description: 'Work' },
			},
			failure: 'save-failed',
		});
		fixture.detectChanges();
		store.outcome.set({
			status: 'succeeded',
			operationId: 4,
			command: { kind: 'undo-activity', recordId: 'record-1' },
		});
		fixture.detectChanges();
	});

	it('does not replay a previously presented failure after remounting', () => {
		store.outcome.set({
			status: 'failed',
			operationId: 7,
			command: {
				kind: 'change-service',
				recordId: 'record-1',
				action: 'archive',
			},
			failure: 'archive-failed',
		});
		fixture.detectChanges();
		expect(app.error()).toContain('could not be archived');

		fixture.destroy();
		fixture = TestBed.createComponent(ServiceRecords);
		fixture.detectChanges();
		app = fixture.componentInstance as unknown as ServiceHarness;
		expect(app.error()).toBe('');
	});
});
