import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ConsumableEntry,
	MaintenanceCar,
	MaintenanceReport,
} from '../maintenance.models';
import {
	ConsumableEntryEditor,
	type ConsumableEntryEditorRequest,
} from './consumable-entry-editor';
import { ConsumableHistory } from './consumable-history';
import { ConsumableMaintenance } from './consumable-maintenance';
import {
	type ConsumableOutcome,
	ConsumableStore,
	type TireLookupOutcome,
} from './consumable-store';

const car: MaintenanceCar = { id: 'car-1', name: 'Buggy', archivedAt: null };
const entry: ConsumableEntry = {
	id: 'entry-1',
	carId: 'car-1',
	kind: 'shock-fluid',
	performedAt: '2026-08-09T12:30:00.000Z',
	fluidArea: 'front-shocks',
};

const store = {
	cars: signal<MaintenanceCar[]>([car]),
	timezone: signal('UTC'),
	entries: signal<ConsumableEntry[]>([entry]),
	report: signal<MaintenanceReport | null>(null),
	loading: signal(false),
	error: signal(''),
	action: signal<string | null>(null),
	outcome: signal<ConsumableOutcome>({ status: 'idle', operationId: null }),
	tireLookup: signal<TireLookupOutcome>({ status: 'idle', carId: null }),
	retry: vi.fn(),
	clearOutcome: vi.fn(),
	loadTires: vi.fn(),
	mutate: vi.fn(),
};

type MaintenanceHarness = {
	activeRequest: ReturnType<typeof signal<ConsumableEntryEditorRequest | null>>;
	historyFilter: ReturnType<typeof signal<'active' | 'archived'>>;
	hasActiveCars(): boolean;
	hasVisibleEntries(): boolean;
	createEntry(): void;
	editEntry(entry: ConsumableEntry): void;
	closeEditor(): void;
	load(): void;
};

describe('ConsumableMaintenance', () => {
	let fixture: ComponentFixture<ConsumableMaintenance>;
	let app: MaintenanceHarness;

	beforeEach(async () => {
		vi.clearAllMocks();
		store.cars.set([car]);
		store.entries.set([entry]);
		store.report.set(null);
		store.loading.set(false);
		store.error.set('');
		store.action.set(null);
		store.outcome.set({ status: 'idle', operationId: null });
		store.tireLookup.set({ status: 'idle', carId: null });
		await TestBed.configureTestingModule({
			imports: [ConsumableMaintenance],
			providers: [{ provide: ConsumableStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(ConsumableMaintenance);
		fixture.detectChanges();
		app = fixture.componentInstance as unknown as MaintenanceHarness;
	});

	const button = (label: string): HTMLButtonElement => {
		const found = [...fixture.nativeElement.querySelectorAll('button')].find(
			(candidate: HTMLButtonElement) => candidate.textContent?.trim() === label,
		);
		expect(found).toBeTruthy();
		return found as HTMLButtonElement;
	};

	it('composes loading, failure, retry, and ready history states', () => {
		store.loading.set(true);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Opening consumable history',
		);
		store.loading.set(false);
		store.error.set('Consumables failed');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Consumables failed');
		button('Try again').click();
		expect(store.clearOutcome).toHaveBeenCalledOnce();
		expect(store.retry).toHaveBeenCalledOnce();
		store.error.set('');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Current history');
		expect(app.hasVisibleEntries()).toBe(true);
	});

	it('coordinates create, edit, cancel, and save requests', () => {
		button('Record change').click();
		fixture.detectChanges();
		expect(app.activeRequest()).toEqual({ kind: 'create' });
		expect(
			fixture.nativeElement.querySelector('#consumable-form-title'),
		).toBeTruthy();
		expect(fixture.nativeElement.querySelector('.history-toolbar')).toBeNull();

		let editor = fixture.debugElement.query(By.directive(ConsumableEntryEditor))
			.componentInstance as ConsumableEntryEditor;
		editor.cancelled.emit();
		fixture.detectChanges();
		expect(app.activeRequest()).toBeNull();

		const history = fixture.debugElement.query(By.directive(ConsumableHistory))
			.componentInstance as ConsumableHistory;
		history.editRequested.emit(entry);
		fixture.detectChanges();
		expect(app.activeRequest()).toEqual({ kind: 'edit', entry });
		editor = fixture.debugElement.query(By.directive(ConsumableEntryEditor))
			.componentInstance as ConsumableEntryEditor;
		editor.saved.emit();
		fixture.detectChanges();
		expect(app.activeRequest()).toBeNull();
	});

	it('guards creation and editing while data is stale or history is read-only', () => {
		store.action.set('refresh');
		fixture.detectChanges();
		expect(button('Record change').disabled).toBe(true);
		app.createEntry();
		app.editEntry(entry);
		expect(app.activeRequest()).toBeNull();

		store.action.set(null);
		store.cars.set([{ ...car, archivedAt: 'x' }]);
		fixture.detectChanges();
		expect(app.hasActiveCars()).toBe(false);
		app.createEntry();
		app.editEntry(entry);
		expect(app.activeRequest()).toBeNull();

		store.cars.set([car]);
		app.editEntry({ ...entry, deletedAt: 'x' });
		expect(app.activeRequest()).toBeNull();
		app.closeEditor();
	});

	it('retains the selected history filter through Angular model binding', () => {
		const history = fixture.debugElement.query(By.directive(ConsumableHistory))
			.componentInstance as ConsumableHistory;
		history.filter.set('archived');
		expect(app.historyFilter()).toBe('archived');
		store.entries.set([{ ...entry, deletedAt: 'x' }]);
		fixture.detectChanges();
		expect(app.hasVisibleEntries()).toBe(true);
		history.filter.set('active');
		expect(app.historyFilter()).toBe('active');

		const propertyFallback = fixture.componentInstance as unknown as {
			historyFilter: 'active' | 'archived';
		};
		propertyFallback.historyFilter = 'active';
		history.filter.set('archived');
		expect(propertyFallback.historyFilter).toBe('archived');
	});

	it('keeps the record launcher available for empty history and disables it without active cars', () => {
		store.entries.set([]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'No consumable changes yet',
		);
		button('Record change').click();
		fixture.detectChanges();
		expect(app.activeRequest()).toEqual({ kind: 'create' });
		app.closeEditor();
		store.cars.set([{ ...car, archivedAt: 'x' }]);
		fixture.detectChanges();
		expect(button('Record change').disabled).toBe(true);
	});
});
