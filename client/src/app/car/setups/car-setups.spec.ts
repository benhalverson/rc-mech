import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import {
	provideRouter,
	Routes,
	withComponentInputBinding,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GarageGateway } from '../../garage/garage-gateway';
import { CarGateway } from '../car-gateway';
import { CarStore } from '../car-store';
import { CarSetups } from './car-setups';
import { CarSetupsStore } from './car-setups-store';
import { SetupSnapshotGateway, SoDialedImportGateway } from './setup-snapshot';
import { SetupSnapshotStore } from './setup-snapshot-store';

const testRoutes: Routes = [
	{
		path: 'garage/:carId/setups',
		component: CarSetups,
		providers: [
			CarGateway,
			GarageGateway,
			CarSetupsStore,
			CarStore,
			SetupSnapshotGateway,
			SetupSnapshotStore,
			SoDialedImportGateway,
		],
	},
];

describe('Car setup route', () => {
	let harness: RouterTestingHarness;

	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [CarSetups],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter(testRoutes, withComponentInputBinding()),
				CarGateway,
				GarageGateway,
				CarSetupsStore,
				CarStore,
				SetupSnapshotGateway,
				SetupSnapshotStore,
				SoDialedImportGateway,
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		harness = await RouterTestingHarness.create();
	});

	afterEach(() => http.verify());

	const car = {
		id: 'car-1',
		name: 'Red Runner',
		make: 'Associated',
		model: 'B7',
		archivedAt: null,
	};

	it('stays idle until route input binding supplies a car', () => {
		const withoutInput = TestBed.createComponent(CarSetups);
		withoutInput.detectChanges();
		http.expectOne('/api/v1/cars').flush({ cars: [] });
		http.expectNone((request) => request.url.includes('/cars//'));
		withoutInput.destroy();
	});

	it('renders and retries a failed car read before setup history loads', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		expect(harness.routeNativeElement?.textContent).toContain(
			'Opening the car record',
		);
		http.expectOne('/api/v1/cars').flush({ cars: [car] });
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		(
			harness.routeNativeElement?.querySelector(
				'[role="alert"] button',
			) as HTMLButtonElement
		).click();
		let retry: TestRequest | undefined;
		await vi.waitFor(() => {
			retry = http.expectOne('/api/v1/cars/car-1');
		});
		retry?.flush({ car });
		let setups: TestRequest | undefined;
		await vi.waitFor(() => {
			setups = http.expectOne('/api/v1/cars/car-1/setups');
		});
		setups?.flush({ setups: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'No setup snapshots yet',
		);
	});

	it('does not retry an expired protected car read', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars').flush({ cars: [car] });
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(
			harness.routeNativeElement?.querySelector('[role="alert"] button'),
		).toBeNull();
	});

	it('explains an expired session while preparing setup imports', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne('/api/v1/cars')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		await harness.fixture.whenStable();
		harness.detectChanges();

		const alert = harness.routeNativeElement?.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Your garage session has expired');
		expect(alert?.querySelector('button')).toBeNull();
		http.expectNone('/api/v1/cars/car-1/setups');
	});

	it('resets setup creation state when a reused route changes cars', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http.expectOne('/api/v1/cars').flush({ cars: [car] });
		let firstSetups: TestRequest | undefined;
		await vi.waitFor(() => {
			firstSetups = http.expectOne('/api/v1/cars/car-1/setups');
		});
		firstSetups?.flush({ setups: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			createAction: () => boolean;
			createError: () => string;
			createCar(identity: { name: string; make: string; model: string }): void;
		};
		component.createCar({ name: 'Pending import', make: '', model: '' });
		const staleCreation = http.expectOne('/api/v1/cars');
		expect(component.createAction()).toBe(true);

		await harness.navigateByUrl('/garage/car-2/setups');
		harness.detectChanges();
		expect(component.createAction()).toBe(false);
		expect(component.createError()).toBe('');
		http
			.expectOne('/api/v1/cars/car-2')
			.flush({ car: { ...car, id: 'car-2' } });
		let nextSetups: TestRequest | undefined;
		await vi.waitFor(() => {
			nextSetups = http.expectOne('/api/v1/cars/car-2/setups');
		});
		nextSetups?.flush({ setups: [] });
		staleCreation.flush({ car: { ...car, id: 'stale-car' } });
	});

	it('identifies an expired setup-import car creation', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http.expectOne('/api/v1/cars').flush({ cars: [car] });
		let setups: TestRequest | undefined;
		await vi.waitFor(() => {
			setups = http.expectOne('/api/v1/cars/car-1/setups');
		});
		setups?.flush({ setups: [] });
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			createCar(identity: { name: string; make: string; model: string }): void;
		};
		component.createCar({ name: 'Imported car', make: '', model: '' });
		http
			.expectOne('/api/v1/cars')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Your garage session has expired',
		);
	});

	it('serializes car creation from a reviewed setup import', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http.expectOne('/api/v1/cars').flush({ cars: [car] });
		let setups: TestRequest | undefined;
		await vi.waitFor(() => {
			setups = http.expectOne('/api/v1/cars/car-1/setups');
		});
		setups?.flush({ setups: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			createCar(identity: { name: string; make: string; model: string }): void;
		};
		const identity = {
			name: ' Imported buggy ',
			make: ' Associated ',
			model: ' ',
		};
		component.createCar(identity);
		component.createCar(identity);
		const creation = http.expectOne('/api/v1/cars');
		expect(creation.request.method).toBe('POST');
		expect(creation.request.body).toEqual({
			name: 'Imported buggy',
			make: 'Associated',
		});
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Creating the new car',
		);
		creation.flush('offline', { status: 503, statusText: 'Unavailable' });
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'The new car could not be created',
		);

		component.createCar(identity);
		http.expectOne('/api/v1/cars').flush({
			car: { ...car, id: 'car-2', name: 'Imported buggy' },
		});
		let collectionRefresh: TestRequest | undefined;
		let carRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			collectionRefresh = http.expectOne('/api/v1/cars');
			carRefresh = http.expectOne('/api/v1/cars/car-2');
		});
		collectionRefresh?.flush({
			cars: [car, { ...car, id: 'car-2', name: 'Imported buggy' }],
		});
		carRefresh?.flush({
			car: { ...car, id: 'car-2', name: 'Imported buggy' },
		});
		let setupRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			setupRefresh = http.expectOne('/api/v1/cars/car-2/setups');
		});
		setupRefresh?.flush({ setups: [] });
	});

	it('retries setup import lookups and handles the child create event', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		await Promise.resolve();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Preparing setup imports',
		);
		http
			.expectOne('/api/v1/cars')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const retry = harness.routeNativeElement?.querySelector(
			'[role="alert"] button',
		) as HTMLButtonElement;
		retry.click();
		let collection: TestRequest | undefined;
		await vi.waitFor(() => {
			collection = http.expectOne('/api/v1/cars');
		});
		collection?.flush({ cars: [car] });
		let setups: TestRequest | undefined;
		await vi.waitFor(() => {
			setups = http.expectOne('/api/v1/cars/car-1/setups');
		});
		setups?.flush({ setups: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();

		const snapshots = harness.routeDebugElement?.query(
			By.css('app-setup-snapshots'),
		);
		snapshots?.triggerEventHandler('createCarFromImport', {
			name: '',
			make: '',
			model: '',
		});
		const creation = http.expectOne('/api/v1/cars');
		expect(creation.request.body).toEqual({ name: 'Imported car' });
		creation.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'new car could not be created',
		);
	});

	it('serializes model-only setup cars and ignores stale creation responses', async () => {
		const open = async (carId: string): Promise<void> => {
			await harness.navigateByUrl(`/garage/${carId}/setups`);
			http.expectOne(`/api/v1/cars/${carId}`).flush({
				car: { ...car, id: carId },
			});
			let setups: TestRequest | undefined;
			await vi.waitFor(() => {
				setups = http.expectOne(`/api/v1/cars/${carId}/setups`);
			});
			setups?.flush({ setups: [] });
		};
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http.expectOne('/api/v1/cars').flush({ cars: [car] });
		let setups: TestRequest | undefined;
		await vi.waitFor(() => {
			setups = http.expectOne('/api/v1/cars/car-1/setups');
		});
		setups?.flush({ setups: [] });
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			createCar(identity: { name: string; make: string; model: string }): void;
		};
		component.createCar({ name: '', make: '', model: ' B7 ' });
		let creation = http.expectOne('/api/v1/cars');
		expect(creation.request.body).toEqual({ name: 'B7', model: 'B7' });
		await open('car-2');
		creation.flush({ car: { ...car, id: 'created-1' } });

		component.createCar({ name: 'Second', make: '', model: '' });
		creation = http.expectOne('/api/v1/cars');
		await open('car-3');
		creation.flush('offline', { status: 503, statusText: 'Unavailable' });
	});
});
