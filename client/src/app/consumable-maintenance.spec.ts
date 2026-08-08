import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import {
	buildTireReport,
	ConsumableEntry,
	ConsumableMaintenance,
	mergeTireReport,
	spendLabel,
} from './consumable-maintenance';
import { MaintenanceLookups } from './maintenance/maintenance-lookups';
import { MaintenanceStore } from './maintenance/maintenance-store';

type Harness = {
	load: () => void;
	openCreate: () => void;
	openEdit: (entry: ConsumableEntry) => void;
	cancelEdit: () => void;
	update: (field: string, value: string) => void;
	changeKind: (event: Event) => void;
	save: (event?: Event) => void;
	archive: (entry: ConsumableEntry) => void;
	restore: (entry: ConsumableEntry) => void;
	visibleEntries: () => ConsumableEntry[];
	isReadOnly: (entry: ConsumableEntry) => boolean;
	carName: (carId: string) => string;
	kindLabel: (kind: ConsumableEntry['kind']) => string;
	areaLabel: (entry: ConsumableEntry) => string;
	axleDetails: (entry: ConsumableEntry, axle: string) => string;
	axleCost: (entry: ConsumableEntry, axle: string) => number | null;
	entryCost: (entry: ConsumableEntry) => string;
	optionalCost: (value: string) => number | null | 'invalid';
	prefillTires: (carId: string) => void;
	localDateTime: (date: Date) => string;
	toIso: (value: string) => string;
	editing: (() => boolean) & { set(value: boolean): void };
	editingId: (() => string | null) & { set(value: string | null): void };
	action: (() => string | null) & { set(value: string | null): void };
	formError: (() => string) & { set(value: string): void };
	mutationError: (() => string) & { set(value: string): void };
	historyFilter: (() => 'active' | 'archived') & {
		set(value: 'active' | 'archived'): void;
	};
	setHistoryFilter: (value: 'active' | 'archived') => void;
	entryFields: () => {
		errorSummary(): Array<{ message?: string }>;
		invalid(): boolean;
	};
	form: (() => Record<string, string> & {
		frontDetails?: string;
		rearDetails?: string;
	}) & {
		set(value: Record<string, string>): void;
	};
	entries: (() => ConsumableEntry[]) & { set(value: ConsumableEntry[]): void };
	garage: (() => unknown[]) & { set(value: unknown[]): void };
};

describe('ConsumableMaintenance', () => {
	it('reports empty history descriptively', () => {
		const report = buildTireReport([]);
		expect(report.front.latest).toBeNull();
		expect(report.front.averageDays).toBeNull();
		expect(report.spend.combined).toBe(0);
		expect(report.fluidEntries).toEqual([]);
	});

	it('preserves the server multi-currency spend state', () => {
		const report = mergeTireReport(buildTireReport([]), {
			tires: {
				frequency: {
					front: { eventCount: 2, averageIntervalDays: 10 },
					rear: { eventCount: 2, averageIntervalDays: 12 },
				},
				spend: {
					front: { total: null },
					rear: { total: 40 },
					combined: { total: null },
				},
			},
			fluidHistory: [],
		});

		expect(report.spend.front).toBeNull();
		expect(report.spend.combined).toBeNull();
		expect(spendLabel(report.spend.combined)).toBe('Multiple currencies');
		expect(spendLabel(report.spend.rear)).toBe('$40.00');
	});

	it('reports one front event without inventing a frequency', () => {
		const entry = tire('front-1', '2026-08-01', 'front', 'Front tire');
		const report = buildTireReport([entry]);
		expect(report.front.latest?.id).toBe('front-1');
		expect(report.front.eventCount).toBe(1);
		expect(report.front.averageDays).toBeNull();
	});

	it('calculates independent front and rear frequency from multiple events', () => {
		const report = buildTireReport([
			tire('front-new', '2026-08-21', 'front', 'Front newer', 30),
			tire(
				'rear-new',
				'2026-08-16',
				'rear',
				undefined,
				undefined,
				'Rear newer',
				40,
			),
			tire('front-old', '2026-08-01', 'front', 'Front older', 20),
			tire(
				'rear-old',
				'2026-08-01',
				'rear',
				undefined,
				undefined,
				'Rear older',
				25,
			),
		]);
		expect(report.front.latest?.id).toBe('front-new');
		expect(report.rear.latest?.id).toBe('rear-new');
		expect(report.front.averageDays).toBe(20);
		expect(report.rear.averageDays).toBe(15);
		expect(report.spend).toMatchObject({ front: 50, rear: 65, combined: 115 });
	});

	it('counts a both-axle entry once for each axle and separates spend', () => {
		const report = buildTireReport([
			tire('both-1', '2026-08-10', 'both', 'Front set', 31, 'Rear set', 37),
		]);
		expect(report.front.eventCount).toBe(1);
		expect(report.rear.eventCount).toBe(1);
		expect(report.spend).toMatchObject({ front: 31, rear: 37, combined: 68 });
	});

	it('keeps recorded spend while identifying missing cost and mixed details', () => {
		const report = buildTireReport([
			tire('mixed', '2026-08-10', 'both', '', 30, 'Rear set'),
			tire(
				'rear-only',
				'2026-08-01',
				'rear',
				undefined,
				undefined,
				'Rear older',
			),
		]);
		expect(report.spend.combined).toBe(30);
		expect(report.spend.missingCostEntries).toBe(2);
		expect(report.front.missingDetails).toBe(true);
		expect(report.rear.missingDetails).toBe(false);
	});

	it('keeps fluid history beside tire reporting', () => {
		const report = buildTireReport([
			fluid('fluid-old', '2026-08-01', 'front-shocks'),
			fluid('fluid-1', '2026-08-02', 'front-shocks'),
			tire('tire-1', '2026-08-01', 'front', 'Front set'),
		]);
		expect(report.fluidEntries.map((entry) => entry.id)).toEqual([
			'fluid-1',
			'fluid-old',
		]);
	});

	it('renders recorded fluid and zero tire costs instead of treating them as missing', () => {
		const app = fixture.componentInstance as unknown as Harness;
		expect(
			app.entryCost({
				id: 'fluid-1',
				carId: 'car-1',
				kind: 'shock-fluid',
				performedAt: '2026-08-02T00:00:00.000Z',
				cost: 12.5,
			}),
		).toBe('USD 12.50');
		expect(
			app.entryCost({
				id: 'tire-1',
				carId: 'car-1',
				kind: 'tires',
				performedAt: '2026-08-02T00:00:00.000Z',
				frontCost: 0,
			}),
		).toBe('USD 0.00');
	});

	let fixture: ComponentFixture<ConsumableMaintenance>;
	let http: HttpTestingController;
	const car = { id: 'car-1', name: 'Red Runner', archivedAt: null };

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [ConsumableMaintenance],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				MaintenanceLookups,
				MaintenanceStore,
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(ConsumableMaintenance);
		fixture.detectChanges();
		http
			.expectOne(
				(request) =>
					request.url === '/api/v1/cars' &&
					request.params.get('archived') === 'all',
			)
			.flush({ cars: [car] });
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/maintenance-plans')
			.flush({ maintenancePlans: [], activity: [] });
		http.expectOne('/api/v1/service-records').flush({ serviceRecords: [] });
		http
			.expectOne('/api/v1/consumable-maintenance')
			.flush({ consumableMaintenance: [] });
		http.expectOne('/api/v1/consumables/report').flush({ report: {} });
		fixture.detectChanges();
	});

	afterEach(() => http.verify());

	it('disables history creation when every car is archived', () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.garage.set([{ ...car, archivedAt: '2026-08-01T00:00:00.000Z' }]);
		fixture.detectChanges();
		const creationButtons = [
			...fixture.nativeElement.querySelectorAll('button'),
		].filter(
			(button: HTMLButtonElement) =>
				button.textContent?.trim() === 'Record change',
		) as HTMLButtonElement[];

		expect(creationButtons).toHaveLength(2);
		expect(creationButtons.every((button) => button.disabled)).toBe(true);
		app.openCreate();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('.consumable-form')).toBeNull();
	});

	it('retries every resource the consumable view depends on', async () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.load();
		let cars: TestRequest | undefined;
		await vi.waitFor(() => {
			cars = http.expectOne(
				(request) =>
					request.url === '/api/v1/cars' &&
					request.params.get('archived') === 'all',
			);
		});
		cars?.flush({ cars: [car] });
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/consumable-maintenance')
			.flush({ consumableMaintenance: [] });
		http.expectOne('/api/v1/consumables/report').flush({ report: {} });
		http.expectNone('/api/v1/maintenance-plans');
		http.expectNone('/api/v1/service-records');
	});

	it('renders loading and retryable consumable read states', async () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.load();
		let cars: TestRequest | undefined;
		await vi.waitFor(() => {
			cars = http.expectOne(
				(request) =>
					request.url === '/api/v1/cars' &&
					request.params.get('archived') === 'all',
			);
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Reading consumable history',
		);
		cars?.flush({ cars: [car] });
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/consumable-maintenance')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		http.expectOne('/api/v1/consumables/report').flush({ report: {} });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Consumable history could not be loaded',
		);
		(
			fixture.nativeElement.querySelector(
				'.error-state button',
			) as HTMLButtonElement
		).click();
		await vi.waitFor(() =>
			http
				.expectOne(
					(request) =>
						request.url === '/api/v1/cars' &&
						request.params.get('archived') === 'all',
				)
				.flush({ cars: [car] }),
		);
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		http
			.expectOne('/api/v1/consumable-maintenance')
			.flush({ consumableMaintenance: [] });
		http.expectOne('/api/v1/consumables/report').flush({ report: {} });
	});

	it('clears an archive failure when the owner retries', async () => {
		const app = fixture.componentInstance as unknown as Harness;
		const entry: ConsumableEntry = {
			id: 'entry-1',
			carId: 'car-1',
			kind: 'shock-fluid',
			performedAt: '2026-08-01T00:00:00.000Z',
			fluidArea: 'front-shocks',
			notes: 'Fresh oil',
		};
		app.entries.set([entry]);
		app.archive(entry);
		http
			.expectOne('/api/v1/cars/car-1/consumable-maintenance/entry-1')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain(
			'That consumable entry could not be archived.',
		);
		expect(fixture.nativeElement.textContent).toContain('Fresh oil');

		app.archive(entry);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).not.toContain(
			'That consumable entry could not be archived.',
		);
		http.expectOne('/api/v1/cars/car-1/consumable-maintenance/entry-1').flush({
			consumableMaintenance: {
				...entry,
				deletedAt: '2026-08-07T00:00:00.000Z',
			},
		});
		let entries: TestRequest | undefined;
		let report: TestRequest | undefined;
		await vi.waitFor(() => {
			entries = http.expectOne('/api/v1/consumable-maintenance');
			report = http.expectOne('/api/v1/consumables/report');
		});
		entries?.flush({ consumableMaintenance: [] });
		report?.flush({ report: {} });
	});

	it('records both axle tire snapshots with distinct details and costs', async () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.openCreate();
		app.form.set({
			carId: 'car-1',
			kind: 'tires',
			performedAt: '2026-08-05T10:00',
			fluidArea: 'front-shocks',
			customArea: '',
			axle: 'both',
			frontDetails: 'Pink compound / front insert',
			rearDetails: 'Green compound / rear insert',
			frontCost: '32.50',
			rearCost: '35',
			notes: 'Outdoor clay',
		});
		app.save();
		const request = http.expectOne('/api/v1/cars/car-1/consumable-maintenance');
		expect(request.request.body).toEqual(
			expect.objectContaining({
				kind: 'tires',
				axle: 'both',
				frontDetails: 'Pink compound / front insert',
				rearDetails: 'Green compound / rear insert',
				frontCost: 32.5,
				rearCost: 35,
			}),
		);
		request.flush({
			consumableMaintenance: {
				id: 'entry-1',
				carId: 'car-1',
				kind: 'tires',
				performedAt: '2026-08-05T17:00:00.000Z',
				axle: 'both',
				frontDetails: 'Pink compound / front insert',
				rearDetails: 'Green compound / rear insert',
				frontCost: 32.5,
				rearCost: 35,
			},
		});
		let entryRefresh: TestRequest | undefined;
		let reportRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			entryRefresh = http.expectOne('/api/v1/consumable-maintenance');
			reportRefresh = http.expectOne('/api/v1/consumables/report');
		});
		entryRefresh?.flush({
			consumableMaintenance: [
				{
					id: 'entry-1',
					carId: 'car-1',
					kind: 'tires',
					performedAt: '2026-08-05T17:00:00.000Z',
					axle: 'both',
					frontDetails: 'Pink compound / front insert',
					rearDetails: 'Green compound / rear insert',
					frontCost: 32.5,
					rearCost: 35,
				},
			],
		});
		reportRefresh?.flush({ report: {} });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(app.entries()[0].frontDetails).toContain('Pink');
		expect(app.entries()[0].rearCost).toBe(35);
	});

	it('sends a front-only tire change without a rear snapshot', () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.openCreate();
		app.form.set({
			...app.form(),
			kind: 'tires',
			axle: 'front',
			performedAt: '2026-08-05T10:00',
			frontDetails: 'Front A',
			frontCost: '18',
		});
		app.save();
		const request = http.expectOne('/api/v1/cars/car-1/consumable-maintenance');
		expect(request.request.body).toMatchObject({
			kind: 'tires',
			axle: 'front',
			frontDetails: 'Front A',
			frontCost: 18,
		});
		expect(request.request.body.rearDetails).toBeUndefined();
	});

	it('sends a rear-only tire change without a front snapshot', () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.openCreate();
		app.form.set({
			...app.form(),
			kind: 'tires',
			axle: 'rear',
			performedAt: '2026-08-05T10:00',
			rearDetails: 'Rear B',
			rearCost: '21',
		});
		app.save();
		const request = http.expectOne('/api/v1/cars/car-1/consumable-maintenance');
		expect(request.request.body).toMatchObject({
			kind: 'tires',
			axle: 'rear',
			rearDetails: 'Rear B',
			rearCost: 21,
		});
		expect(request.request.body.frontDetails).toBeUndefined();
	});

	it('prefills tire details from the current setup but sends a historical snapshot', () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.openCreate();
		app.update('kind', 'tires');
		http
			.expectOne('/api/v1/cars/car-1/setups/current')
			.flush({ setup: { tires: { front: 'Blue', insert: 'Medium' } } });
		expect(app.form().frontDetails).toContain('front: Blue');
		expect(app.form().rearDetails).toContain('insert: Medium');
		app.form.set({
			...app.form(),
			axle: 'front',
			performedAt: '2026-08-05T10:00',
		});
		app.save();
		const request = http.expectOne('/api/v1/cars/car-1/consumable-maintenance');
		expect(request.request.body.frontDetails).toContain('front: Blue');
		expect(request.request.body.rearDetails).toBeUndefined();
	});

	it('applies the same tire cleanup through the programmatic kind update', () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.openCreate();
		app.form.set({
			...app.form(),
			kind: 'tires',
			axle: 'both',
			rearDetails: 'Rear set',
			rearCost: '25',
		});

		app.update('kind', 'shock-fluid');

		expect(app.form()).toMatchObject({
			kind: 'shock-fluid',
			axle: 'front',
			rearDetails: '',
			rearCost: '',
		});
	});

	it('applies kind cleanup from the selected event value', () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.openCreate();
		app.form.set({
			...app.form(),
			kind: 'tires',
			axle: 'both',
			rearDetails: 'Rear set',
			rearCost: '25',
		});
		const select = document.createElement('select');
		select.add(new Option('Shock fluid', 'shock-fluid'));
		select.value = 'shock-fluid';
		select.addEventListener('change', (event) => app.changeKind(event));

		select.dispatchEvent(new Event('change'));

		expect(app.form()).toMatchObject({
			kind: 'shock-fluid',
			axle: 'front',
			rearDetails: '',
			rearCost: '',
		});
	});

	it('records a fluid service area and optional cost', () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.openCreate();
		app.form.set({
			...app.form(),
			kind: 'differential-fluid',
			fluidArea: 'rear-differential',
			performedAt: '2026-08-05T10:00',
			frontCost: '12.75',
			notes: '7k oil',
		});
		app.save();
		const request = http.expectOne('/api/v1/cars/car-1/consumable-maintenance');
		expect(request.request.body).toMatchObject({
			kind: 'differential-fluid',
			fluidArea: 'rear-differential',
			cost: 12.75,
			notes: '7k oil',
		});
	});

	it('archives and restores an entry without removing its history', async () => {
		const app = fixture.componentInstance as unknown as Harness;
		const entry: ConsumableEntry = {
			id: 'entry-1',
			carId: 'car-1',
			kind: 'shock-fluid',
			performedAt: '2026-08-01T00:00:00.000Z',
			fluidArea: 'front-shocks',
		};
		app.entries.set([entry]);
		app.archive(entry);
		const deletion = http.expectOne(
			'/api/v1/cars/car-1/consumable-maintenance/entry-1',
		);
		expect(deletion.request.method).toBe('DELETE');
		const archived = { ...entry, deletedAt: '2026-08-05T00:00:00.000Z' };
		deletion.flush({ consumableMaintenance: archived });
		let archivedEntries: TestRequest | undefined;
		let archivedReport: TestRequest | undefined;
		await vi.waitFor(() => {
			archivedEntries = http.expectOne('/api/v1/consumable-maintenance');
			archivedReport = http.expectOne('/api/v1/consumables/report');
		});
		archivedEntries?.flush({ consumableMaintenance: [archived] });
		archivedReport?.flush({ report: {} });
		await fixture.whenStable();
		fixture.detectChanges();
		app.restore(archived);
		const restore = http.expectOne(
			'/api/v1/cars/car-1/consumable-maintenance/entry-1/restore',
		);
		expect(restore.request.method).toBe('POST');
		restore.flush({ consumableMaintenance: entry });
		let restoredEntries: TestRequest | undefined;
		let restoredReport: TestRequest | undefined;
		await vi.waitFor(() => {
			restoredEntries = http.expectOne('/api/v1/consumable-maintenance');
			restoredReport = http.expectOne('/api/v1/consumables/report');
		});
		restoredEntries?.flush({ consumableMaintenance: [entry] });
		restoredReport?.flush({ report: {} });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(app.entries()[0].deletedAt).toBeUndefined();
	});

	it('opens and cancels edits across fluid and tire fallback values', () => {
		const app = fixture.componentInstance as unknown as Harness;
		const archived = fluid('archived', '2026-08-01', 'front-shocks');
		app.garage.set([{ ...car, archivedAt: '2026-08-02T00:00:00.000Z' }]);
		app.openEdit(archived);
		expect(app.editing()).toBe(false);

		app.garage.set([car]);
		app.openEdit({
			...tire('tire-edit', '2026-08-03', 'both'),
			fluidArea: undefined,
			customArea: undefined,
			frontDetails: undefined,
			rearDetails: undefined,
			frontCost: undefined,
			rearCost: undefined,
			notes: undefined,
		});
		expect(app.form()).toMatchObject({
			fluidArea: 'front-shocks',
			customArea: '',
			axle: 'both',
			frontDetails: '',
			rearDetails: '',
			frontCost: '',
			rearCost: '',
			notes: '',
		});
		app.cancelEdit();
		expect(app.editing()).toBe(false);

		app.openEdit({
			...fluid('fluid-edit', '2026-08-04', 'custom'),
			customArea: 'Center diff',
			cost: 12,
			rearCost: 4,
			notes: 'Changed',
		});
		expect(app.form()).toMatchObject({
			customArea: 'Center diff',
			frontCost: '12',
			rearCost: '4',
			notes: 'Changed',
		});
	});

	it('covers form validation focus paths, tire detail validation, and action guard', () => {
		const app = fixture.componentInstance as unknown as Harness;
		const preventDefault = vi.fn();
		app.openCreate();
		app.form.set({ ...app.form(), carId: '', performedAt: '' });
		app.save({ preventDefault } as unknown as Event);
		expect(preventDefault).toHaveBeenCalled();
		expect(app.formError()).toContain('Choose a car');

		app.form.set({ ...app.form(), carId: 'car-1', performedAt: '' });
		app.save();
		expect(app.formError()).toContain('change date');

		app.form.set({
			...app.form(),
			performedAt: '2026-08-05T10:00',
			frontCost: '-1',
		});
		app.save();
		expect(app.formError()).toContain('Costs');
		app.form.set({ ...app.form(), frontCost: '', rearCost: 'NaN' });
		app.save();
		expect(app.formError()).toContain('Costs');
		app.form.set({ ...app.form(), rearCost: '', notes: 'x'.repeat(4001) });
		app.save();
		expect(app.formError()).toContain('4,000');

		app.form.set({
			...app.form(),
			notes: '',
			kind: 'tires',
			axle: 'front',
			frontDetails: '',
			frontCost: '',
		});
		app.save();
		expect(app.formError()).toContain('front or rear tire details');
		app.form.set({
			...app.form(),
			axle: 'rear',
			rearDetails: '',
			rearCost: '',
		});
		app.save();
		expect(app.formError()).toContain('front or rear tire details');

		expect(app.optionalCost('')).toBeNull();
		expect(app.optionalCost('-2')).toBe('invalid');
		expect(app.optionalCost('not-a-number')).toBe('invalid');
		expect(app.optionalCost('0')).toBe(0);
		app.action.set('busy');
		app.form.set({ ...app.form(), axle: 'front', frontDetails: 'Ready' });
		app.save();
		http.expectNone((request) => request.method === 'POST');
	});

	it('rejects invalid optional costs even when field validation is bypassed', () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.openCreate();
		Object.defineProperty(app.entryFields(), 'invalid', { value: () => false });
		app.form.set({
			...app.form(),
			carId: 'car-1',
			performedAt: '2026-08-05T10:00',
			frontCost: '-1',
		});
		app.save();
		expect(app.formError()).toBe('Costs must be zero or greater.');
	});

	it('uses the defensive validation fallback and saves custom fluid edits', async () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.openCreate();
		Object.defineProperty(app.entryFields(), 'errorSummary', {
			value: () => [],
		});
		app.form.set({ ...app.form(), carId: '', performedAt: '' });
		app.save();
		expect(app.formError()).toBe('Review the consumable history fields.');

		const entry = {
			...fluid('fluid-edit', '2026-08-04', 'custom'),
			customArea: 'Center differential',
		};
		app.openEdit(entry);
		app.form.set({
			...app.form(),
			performedAt: '2026-08-05T10:00',
			frontCost: '',
			notes: '',
		});
		app.save();
		const update = http.expectOne(
			'/api/v1/cars/car-1/consumable-maintenance/fluid-edit',
		);
		expect(update.request.method).toBe('PATCH');
		expect(update.request.body).toMatchObject({
			fluidArea: 'custom',
			customArea: 'Center differential',
		});
		expect(update.request.body.cost).toBeUndefined();
		update.flush({ consumableMaintenance: entry });
		await vi.waitFor(() => {
			http
				.expectOne('/api/v1/consumable-maintenance')
				.flush({ consumableMaintenance: [] });
			http.expectOne('/api/v1/consumables/report').flush({ report: {} });
		});
		expect(app.editing()).toBe(false);
	});

	it('maps save and restore failures and honors archive and restore guards', () => {
		const app = fixture.componentInstance as unknown as Harness;
		const entry = fluid('entry-guard', '2026-08-01', 'front-shocks');
		app.garage.set([{ ...car, archivedAt: '2026-08-02T00:00:00.000Z' }]);
		app.archive(entry);
		http.expectNone((request) => request.method === 'DELETE');
		app.garage.set([car]);
		app.action.set('busy');
		app.archive(entry);
		app.restore(entry);
		http.expectNone((request) => request.url.includes('entry-guard'));
		app.action.set(null);

		app.openCreate();
		app.form.set({
			...app.form(),
			carId: 'car-1',
			performedAt: '2026-08-05T10:00',
		});
		app.save();
		http
			.expectOne('/api/v1/cars/car-1/consumable-maintenance')
			.flush('archived', { status: 409, statusText: 'Conflict' });
		expect(app.formError()).toContain('car is archived');
		app.save();
		http
			.expectOne('/api/v1/cars/car-1/consumable-maintenance')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		expect(app.formError()).toContain('could not be saved');

		app.restore({ ...entry, deletedAt: '2026-08-02T00:00:00.000Z' });
		http
			.expectOne(
				'/api/v1/cars/car-1/consumable-maintenance/entry-guard/restore',
			)
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		expect(app.mutationError()).toContain('could not be restored');
	});

	it('filters history and labels all entry variants', () => {
		const app = fixture.componentInstance as unknown as Harness;
		const active = fluid('active', '2026-08-02', 'custom');
		const archived = {
			...tire('archived', '2026-08-01', 'rear'),
			deletedAt: '2026-08-03T00:00:00.000Z',
		};
		app.entries.set([active, archived]);
		expect(app.visibleEntries()).toEqual([active]);
		app.setHistoryFilter('archived');
		expect(app.visibleEntries()).toEqual([archived]);
		expect(app.isReadOnly(archived)).toBe(true);
		expect(app.carName('missing')).toBe('Unknown car');
		expect(app.kindLabel('tires')).toBe('Tire set');
		expect(app.kindLabel('shock-fluid')).toBe('Shock fluid');
		expect(app.kindLabel('differential-fluid')).toBe('Differential fluid');
		expect(app.areaLabel(archived)).toBe('rear axle');
		expect(app.areaLabel({ ...archived, axle: undefined })).toBe('front axle');
		expect(app.areaLabel(active)).toBe('Custom area');
		expect(app.areaLabel({ ...active, customArea: 'Center' })).toBe('Center');
		expect(app.areaLabel({ ...active, fluidArea: 'rear-differential' })).toBe(
			'rear differential',
		);
		expect(app.areaLabel({ ...active, fluidArea: undefined })).toBe('');
		expect(app.axleDetails(archived, 'front')).toBe('Details not recorded.');
		expect(
			app.axleDetails({ ...archived, rearDetails: 'Rear B' }, 'rear'),
		).toBe('Rear B');
		expect(app.axleCost({ ...archived, frontCost: 12 }, 'front')).toBe(12);
		expect(app.axleCost(archived, 'front')).toBeNull();
		expect(app.axleCost(archived, 'rear')).toBeNull();
		expect(app.entryCost(active)).toBe('No cost logged');
		expect(app.entryCost(archived)).toBe('No cost logged');
		expect(app.entryCost({ ...active, cost: 2, currency: 'EUR' })).toBe(
			'EUR 2.00',
		);
	});

	it('handles missing tire lookups and date conversion fallbacks', () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.prefillTires('');
		http.expectNone((request) => request.url.includes('/setups/current'));
		app.prefillTires('car-1');
		http.expectOne('/api/v1/cars/car-1/setups/current').flush({ setup: {} });
		expect(app.toIso('')).toBe('');
		expect(app.toIso('2026-08-05')).toBe('');
		expect(app.localDateTime(new Date('2026-08-05T10:00:00.000Z'))).toContain(
			'2026-08-05T10:00',
		);
		const browserIntl = Intl;
		vi.stubGlobal('Intl', {
			DateTimeFormat: class {
				formatToParts(): Intl.DateTimeFormatPart[] {
					return [];
				}
			},
		});
		expect(app.localDateTime(new Date('2026-08-05T10:00:00.000Z'))).toBe(
			'--T:',
		);
		vi.stubGlobal('Intl', browserIntl);
	});

	it('handles an active-car list that changes while opening creation', () => {
		const app = fixture.componentInstance as unknown as Harness;
		let reads = 0;
		app.garage.set([
			{
				id: 'car-1',
				name: 'Changing car',
				get archivedAt() {
					reads += 1;
					return reads > 1 ? '2026-08-01T00:00:00.000Z' : null;
				},
			},
		]);
		app.openCreate();
		expect(app.form()['carId']).toBe('');
	});

	it('opens a tire edit with recorded front cost', () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.openEdit(tire('priced', '2026-08-04', 'front', 'Front', 22));
		expect(app.form()['frontCost']).toBe('22');
	});

	it('ignores kind changes from non-select event targets', () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.update('notes', 'Changed');
		expect(app.form()['notes']).toBe('Changed');
		const before = app.form()['kind'];
		app.changeKind({
			target: document.createElement('input'),
		} as unknown as Event);
		expect(app.form()['kind']).toBe(before);
	});

	it('executes the consumable ledger controls through the rendered template', () => {
		const app = fixture.componentInstance as unknown as Harness;
		const tireEntry = {
			...tire('tire-active', '2026-08-05', 'both', 'Front A', 20, 'Rear B', 25),
			notes: 'Race set',
		};
		const fluidEntry = {
			...fluid('fluid-active', '2026-08-04', 'custom'),
			customArea: 'Center diff',
			cost: 10,
			notes: 'Fresh oil',
		};
		const archived = {
			...tire('tire-archived', '2026-07-01', 'rear'),
			deletedAt: '2026-08-01T00:00:00.000Z',
		};
		app.entries.set([tireEntry, fluidEntry, archived]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Front A');
		expect(fixture.nativeElement.textContent).toContain('Fresh oil');

		const byText = (label: string): HTMLButtonElement => {
			const button = [...fixture.nativeElement.querySelectorAll('button')].find(
				(candidate: HTMLButtonElement) =>
					candidate.textContent?.trim() === label,
			);
			expect(button).toBeTruthy();
			return button as HTMLButtonElement;
		};

		byText('Archived entries').click();
		fixture.detectChanges();
		byText('Restore').click();
		http
			.expectOne(
				'/api/v1/cars/car-1/consumable-maintenance/tire-archived/restore',
			)
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		fixture.detectChanges();
		byText('Current history').click();
		fixture.detectChanges();

		byText('Edit').click();
		fixture.detectChanges();
		const kind = fixture.nativeElement.querySelector(
			'select[ng-reflect-name]',
		) as HTMLSelectElement | null;
		if (kind) {
			kind.value = 'shock-fluid';
			kind.dispatchEvent(new Event('change'));
		}
		byText('Cancel').click();
		fixture.detectChanges();

		byText('Archive').click();
		http
			.expectOne('/api/v1/cars/car-1/consumable-maintenance/tire-active')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		fixture.detectChanges();

		byText('Record change').click();
		fixture.detectChanges();
		byText('Save change').click();
		http
			.expectOne('/api/v1/cars/car-1/consumable-maintenance')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
	});

	it('renders every consumable form and report variant', async () => {
		const app = fixture.componentInstance as unknown as Harness;
		await fixture.whenStable();
		fixture.detectChanges();
		const emptyCreate = fixture.nativeElement.querySelector(
			'.empty-state button',
		) as HTMLButtonElement;
		emptyCreate.click();
		app.garage.set([
			car,
			{ ...car, id: 'archived-car', archivedAt: '2026-08-01T00:00:00.000Z' },
		]);
		fixture.detectChanges();
		const form = fixture.nativeElement.querySelector(
			'form.consumable-form',
		) as HTMLFormElement;
		const kind = form.querySelectorAll('select')[1] as HTMLSelectElement;
		app.formError.set('Review this entry');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Review this entry');
		app.formError.set('');
		kind.value = 'differential-fluid';
		kind.dispatchEvent(new Event('change'));
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('front differential');
		app.form.set({ ...app.form(), fluidArea: 'custom' });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Custom service area');

		for (const axle of ['front', 'rear', 'both']) {
			app.form.set({ ...app.form(), kind: 'tires', axle });
			fixture.detectChanges();
			expect(fixture.nativeElement.textContent).toContain('Axle sets');
		}
		app.action.set('busy');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Saving…');
		app.action.set(null);
		fixture.detectChanges();
		(
			fixture.nativeElement.querySelector(
				'.form-actions .quiet',
			) as HTMLButtonElement
		).click();

		const recent = tire(
			'recent',
			'2026-08-20',
			'both',
			'',
			undefined,
			'Rear recent',
			25,
		);
		const old = tire(
			'old',
			'2026-08-01',
			'both',
			'Front old',
			20,
			'Rear old',
			20,
		);
		const fluidWithoutNotes = fluid('fluid', '2026-08-02', 'rear-shocks');
		app.entries.set([recent, old, fluidWithoutNotes]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'days between recorded',
		);
		expect(fixture.nativeElement.textContent).toContain(
			'incomplete tire details',
		);
		expect(fixture.nativeElement.textContent).toContain(
			'Cost not recorded for this axle event',
		);
		expect(fixture.nativeElement.textContent).toContain(
			'Fluid service recorded',
		);
		expect(fixture.nativeElement.textContent).toContain(
			'event has no recorded cost',
		);

		app.entries.set([
			recent,
			old,
			tire('missing-two', '2026-08-10', 'front', 'Front', undefined),
			tire(
				'missing-rear',
				'2026-08-09',
				'rear',
				undefined,
				undefined,
				'Rear no cost',
				undefined,
			),
			fluidWithoutNotes,
		]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'events have no recorded cost',
		);
	});
});

function tire(
	id: string,
	performedAt: string,
	axle: 'front' | 'rear' | 'both',
	frontDetails?: string,
	frontCost?: number,
	rearDetails?: string,
	rearCost?: number,
): ConsumableEntry {
	return {
		id,
		carId: 'car-1',
		kind: 'tires',
		performedAt: `${performedAt}T00:00:00.000Z`,
		axle,
		frontDetails,
		frontCost,
		rearDetails,
		rearCost,
	};
}

function fluid(
	id: string,
	performedAt: string,
	fluidArea: ConsumableEntry['fluidArea'],
): ConsumableEntry {
	return {
		id,
		carId: 'car-1',
		kind: 'shock-fluid',
		performedAt: `${performedAt}T00:00:00.000Z`,
		fluidArea,
	};
}
