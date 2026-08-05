import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
	ConsumableMaintenance,
	ConsumableEntry,
} from './consumable-maintenance';

type Harness = {
	openCreate: () => void;
	openEdit: (entry: ConsumableEntry) => void;
	update: (field: string, value: string) => void;
	save: () => void;
	archive: (entry: ConsumableEntry) => void;
	restore: (entry: ConsumableEntry) => void;
	form: (() => Record<string, string>) & {
		set(value: Record<string, string>): void;
	};
	entries: (() => ConsumableEntry[]) & { set(value: ConsumableEntry[]): void };
};

describe('ConsumableMaintenance', () => {
	let fixture: ComponentFixture<ConsumableMaintenance>;
	let http: HttpTestingController;
	const car = { id: 'car-1', name: 'Red Runner', archivedAt: null };

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [ConsumableMaintenance],
			providers: [provideHttpClient(), provideHttpClientTesting()],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(ConsumableMaintenance);
		fixture.componentRef.setInput('enabled', true);
		fixture.componentRef.setInput('cars', [car]);
		http
			.expectOne('/api/v1/cars/car-1/consumable-maintenance?history=true')
			.flush({ entries: [] });
		fixture.detectChanges();
	});

	afterEach(() => http.verify());

	it('records both axle tire snapshots with distinct details and costs', () => {
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
		expect(request.request.body['rearDetails']).toBeUndefined();
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
		expect(request.request.body['frontDetails']).toBeUndefined();
	});

	it('prefills tire details from the current setup but sends a historical snapshot', () => {
		const app = fixture.componentInstance as unknown as Harness;
		app.openCreate();
		app.update('kind', 'tires');
		http
			.expectOne('/api/v1/cars/car-1/setups/current')
			.flush({ setup: { tires: { front: 'Blue', insert: 'Medium' } } });
		expect(app.form()['frontDetails']).toContain('front: Blue');
		expect(app.form()['rearDetails']).toContain('insert: Medium');
		app.form.set({
			...app.form(),
			axle: 'front',
			performedAt: '2026-08-05T10:00',
		});
		app.save();
		const request = http.expectOne('/api/v1/cars/car-1/consumable-maintenance');
		expect(request.request.body['frontDetails']).toContain('front: Blue');
		expect(request.request.body['rearDetails']).toBeUndefined();
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

	it('archives and restores an entry without removing its history', () => {
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
		app.restore(archived);
		const restore = http.expectOne(
			'/api/v1/cars/car-1/consumable-maintenance/entry-1/restore',
		);
		expect(restore.request.method).toBe('POST');
		restore.flush({ consumableMaintenance: entry });
		expect(app.entries()[0].deletedAt).toBeUndefined();
	});
});
