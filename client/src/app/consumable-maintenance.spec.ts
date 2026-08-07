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
	update: (field: string, value: string) => void;
	changeKind: (event: Event) => void;
	save: () => void;
	archive: (entry: ConsumableEntry) => void;
	restore: (entry: ConsumableEntry) => void;
	entryCost: (entry: ConsumableEntry) => string;
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
			fluid('fluid-1', '2026-08-02', 'front-shocks'),
			tire('tire-1', '2026-08-01', 'front', 'Front set'),
		]);
		expect(report.fluidEntries.map((entry) => entry.fluidArea)).toEqual([
			'front-shocks',
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
