import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ConsumableEntry,
	MaintenanceCar,
	MaintenanceReport,
} from '../maintenance.models';
import { ConsumableHistory } from './consumable-history';
import { type ConsumableOutcome, ConsumableStore } from './consumable-store';

const car: MaintenanceCar = { id: 'car-1', name: 'Buggy', archivedAt: null };
const front: ConsumableEntry = {
	id: 'front-1',
	carId: 'car-1',
	kind: 'tires',
	performedAt: '2026-08-09T12:30:00.000Z',
	axle: 'front',
	frontDetails: 'Cut pin',
	frontCost: 0,
};
const fluid: ConsumableEntry = {
	id: 'fluid-1',
	carId: 'car-1',
	kind: 'shock-fluid',
	performedAt: '2026-08-08T12:30:00.000Z',
	fluidArea: 'custom',
	customArea: 'Center differential',
	cost: 12.5,
	currency: 'USD',
	notes: 'Changed viscosity',
};
const emptyReport: MaintenanceReport = {
	tires: {
		frequency: {
			front: { eventCount: 0, averageIntervalDays: null },
			rear: { eventCount: 0, averageIntervalDays: null },
		},
		spend: {
			front: { total: 0 },
			rear: { total: 0 },
			combined: { total: 0 },
		},
	},
	fluidHistory: [],
};

const store = {
	cars: signal<MaintenanceCar[]>([car]),
	timezone: signal('UTC'),
	entries: signal<ConsumableEntry[]>([front, fluid]),
	report: signal<MaintenanceReport | null>(null),
	action: signal<string | null>(null),
	outcome: signal<ConsumableOutcome>({ status: 'idle', operationId: null }),
	mutate: vi.fn(),
};

type HistoryHarness = {
	filter: ReturnType<typeof signal<'active' | 'archived'>>;
	error: ReturnType<typeof signal<string>>;
	visibleEntries(): ConsumableEntry[];
	create(): void;
	edit(entry: ConsumableEntry): void;
	archive(entry: ConsumableEntry): void;
	restore(entry: ConsumableEntry): void;
	isReadOnly(entry: ConsumableEntry): boolean;
	carName(carId: string): string;
	kindLabel(kind: ConsumableEntry['kind']): string;
	areaLabel(entry: ConsumableEntry): string;
	axleDetails(entry: ConsumableEntry, axle: 'front' | 'rear'): string;
	axleCost(entry: ConsumableEntry, axle: 'front' | 'rear'): number | null;
	entryCost(entry: ConsumableEntry): string;
};

describe('ConsumableHistory', () => {
	let fixture: ComponentFixture<ConsumableHistory>;
	let app: HistoryHarness;

	beforeEach(async () => {
		vi.clearAllMocks();
		store.cars.set([car]);
		store.entries.set([front, fluid]);
		store.report.set(null);
		store.action.set(null);
		store.outcome.set({ status: 'idle', operationId: null });
		await TestBed.configureTestingModule({
			imports: [ConsumableHistory],
			providers: [{ provide: ConsumableStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(ConsumableHistory);
		fixture.detectChanges();
		app = fixture.componentInstance as unknown as HistoryHarness;
	});

	const button = (label: string): HTMLButtonElement => {
		const found = [...fixture.nativeElement.querySelectorAll('button')].find(
			(candidate: HTMLButtonElement) => candidate.textContent?.trim() === label,
		);
		expect(found).toBeTruthy();
		return found as HTMLButtonElement;
	};

	it('renders reports, history details, costs, and presentation fallbacks', () => {
		store.entries.set([
			front,
			fluid,
			{ ...fluid, id: 'fluid-empty', cost: null, notes: null },
			{
				...front,
				id: 'rear-1',
				axle: 'rear',
				frontDetails: null,
				frontCost: null,
				rearDetails: 'Rear pin',
				rearCost: 15,
			},
		]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Cut pin');
		expect(fixture.nativeElement.textContent).toContain('Changed viscosity');
		expect(fixture.nativeElement.textContent).toContain(
			'Fluid service recorded',
		);
		expect(fixture.nativeElement.textContent).toContain('Rear pin');
		expect(fixture.nativeElement.textContent).toContain('USD 0.00');
		expect(app.carName('missing')).toBe('Unknown car');
		expect(app.kindLabel('tires')).toBe('Tire set');
		expect(app.kindLabel('shock-fluid')).toBe('Shock fluid');
		expect(app.kindLabel('differential-fluid')).toBe('Differential fluid');
		expect(app.areaLabel(front)).toBe('front axle');
		expect(app.areaLabel({ ...front, axle: null })).toBe('front axle');
		expect(app.areaLabel(fluid)).toBe('Center differential');
		expect(app.areaLabel({ ...fluid, customArea: null })).toBe('Custom area');
		expect(app.areaLabel({ ...fluid, fluidArea: 'rear-differential' })).toBe(
			'rear differential',
		);
		expect(app.areaLabel({ ...fluid, fluidArea: null })).toBe('');
		expect(app.axleDetails(front, 'front')).toBe('Cut pin');
		expect(app.axleDetails(front, 'rear')).toBe('Details not recorded.');
		expect(app.axleCost(front, 'front')).toBe(0);
		expect(app.axleCost(front, 'rear')).toBeNull();
		expect(app.entryCost({ ...fluid, cost: null })).toBe('No cost logged');
		expect(app.entryCost({ ...fluid, currency: null })).toBe('USD 12.50');
		expect(app.entryCost({ ...front, frontCost: null })).toBe('No cost logged');
		expect(
			app.entryCost({ ...front, axle: 'both', rearCost: 10, currency: 'CAD' }),
		).toBe('CAD 10.00');
	});

	it('filters entries and emits create and edit intents through rendered controls', () => {
		const created: number[] = [];
		const edited: ConsumableEntry[] = [];
		fixture.componentInstance.createRequested.subscribe(() => created.push(1));
		fixture.componentInstance.editRequested.subscribe((entry) =>
			edited.push(entry),
		);
		button('Edit').click();
		expect(edited).toEqual([front]);

		store.entries.set([]);
		fixture.detectChanges();
		button('Record change').click();
		expect(created).toEqual([1]);
		button('Archived entries').click();
		fixture.detectChanges();
		expect(app.filter()).toBe('archived');
		expect(fixture.nativeElement.textContent).toContain('0 entries');
		button('Current history').click();
		expect(app.filter()).toBe('active');
	});

	it('archives, restores, and blocks stale or read-only commands', () => {
		button('Archive').click();
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'change',
			action: 'archive',
			entry: front,
		});

		const archived = { ...front, id: 'archived', deletedAt: 'x' };
		store.entries.set([archived]);
		app.filter.set('archived');
		fixture.detectChanges();
		button('Restore').click();
		expect(store.mutate).toHaveBeenLastCalledWith({
			kind: 'change',
			action: 'restore',
			entry: archived,
		});

		store.action.set('refresh');
		fixture.detectChanges();
		expect(button('Restore').disabled).toBe(true);
		store.mutate.mockClear();
		app.create();
		app.edit(front);
		app.archive(front);
		app.restore(archived);
		expect(store.mutate).not.toHaveBeenCalled();
		store.action.set(null);
		store.cars.set([{ ...car, archivedAt: 'x' }]);
		expect(app.isReadOnly(front)).toBe(true);
		app.edit(front);
		app.archive(front);
		expect(app.isReadOnly(archived)).toBe(true);
		store.cars.set([]);
		app.create();
	});

	it('maps archive and restore failures once and ignores unrelated outcomes', () => {
		for (const [operationId, failure, message, action] of [
			[1, 'archive-failed', 'could not be archived', 'archive'],
			[2, 'restore-failed', 'could not be restored', 'restore'],
		] as const) {
			store.outcome.set({
				status: 'failed',
				operationId,
				command: { kind: 'change', action, entry: front },
				failure,
			});
			fixture.detectChanges();
			expect(app.error()).toContain(message);
		}
		store.outcome.set({
			status: 'failed',
			operationId: 2,
			command: { kind: 'change', action: 'restore', entry: front },
			failure: 'restore-failed',
		});
		fixture.detectChanges();
		store.outcome.set({
			status: 'failed',
			operationId: 3,
			command: {
				kind: 'save',
				mode: 'create',
				carId: 'car-1',
				id: null,
				maintenance: {
					kind: 'shock-fluid',
					performedAt: fluid.performedAt,
					fluidArea: 'front-shocks',
				},
			},
			failure: 'save-failed',
		});
		fixture.detectChanges();
		store.outcome.set({
			status: 'succeeded',
			operationId: 4,
			command: { kind: 'change', action: 'archive', entry: front },
		});
		fixture.detectChanges();
	});

	it('does not replay a previously presented failure after remounting', () => {
		store.outcome.set({
			status: 'failed',
			operationId: 7,
			command: { kind: 'change', action: 'archive', entry: front },
			failure: 'archive-failed',
		});
		fixture.detectChanges();
		expect(app.error()).toContain('could not be archived');

		fixture.destroy();
		fixture = TestBed.createComponent(ConsumableHistory);
		fixture.detectChanges();
		app = fixture.componentInstance as unknown as HistoryHarness;
		expect(app.error()).toBe('');
	});

	it('renders empty, archived, average-frequency, and warning report states', () => {
		store.entries.set([]);
		store.report.set(emptyReport);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('No recorded change');
		expect(fixture.nativeElement.textContent).toContain(
			'No shock-fluid or differential-fluid changes recorded',
		);

		store.report.set(null);
		store.entries.set([
			{ ...front, id: 'new', frontDetails: '', frontCost: null },
			{
				...front,
				id: 'old',
				performedAt: '2026-07-30T12:30:00.000Z',
				frontCost: 10,
			},
			{
				...front,
				id: 'rear',
				axle: 'rear',
				frontDetails: null,
				rearDetails: 'Rear set',
				rearCost: null,
			},
			fluid,
		]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'days between recorded',
		);
		expect(fixture.nativeElement.textContent).toContain(
			'incomplete tire details',
		);
		expect(fixture.nativeElement.textContent).toContain(
			'events have no recorded cost',
		);

		store.entries.set([{ ...front, frontCost: null }]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'event has no recorded cost',
		);

		store.entries.set([{ ...front, deletedAt: 'x' }]);
		app.filter.set('archived');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Archived');
	});
});
