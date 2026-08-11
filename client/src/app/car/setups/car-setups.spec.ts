import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	TestRequest,
} from '@angular/common/http/testing';
import { signal, untracked } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import {
	provideRouter,
	Router,
	Routes,
	withComponentInputBinding,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	CarSyncCommand,
	CarSyncOperation,
} from '../../garage/car-sync/car-sync.models';
import {
	type CarWorkspaceMutationOutcome,
	CarWorkspaceStore,
} from '../../garage/car-sync/car-workspace-store';
import type { GarageCar } from '../../garage/garage.models';
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

class FakeCarWorkspaceStore {
	readonly opened = signal(false);
	readonly cars = signal<readonly GarageCar[]>([]);
	readonly operations = signal<readonly CarSyncOperation[]>([]);
	readonly mutationsAvailable = signal(true);
	readonly mutationOutcome = signal<CarWorkspaceMutationOutcome>({
		status: 'idle',
		requestId: null,
	});
	preserveCommandIdentity = true;
	private requestId = 0;
	readonly commit = vi.fn((command: CarSyncCommand) => {
		if (
			!this.mutationsAvailable() ||
			this.mutationOutcome().status === 'pending'
		)
			return;
		this.mutationOutcome.set({
			status: 'pending',
			requestId: ++this.requestId,
			command: this.preserveCommandIdentity ? command : { ...command },
		});
	});
	readonly clearMutationState = vi.fn(() => {
		if (this.mutationOutcome().status !== 'pending')
			this.mutationOutcome.set({ status: 'idle', requestId: null });
	});
	readonly observeServerCars = vi.fn((cars: readonly GarageCar[]) => {
		const merged = new Map(untracked(this.cars).map((car) => [car.id, car]));
		for (const car of cars) merged.set(car.id, car);
		this.cars.set([...merged.values()]);
		this.opened.set(true);
	});
	readonly retrySync = vi.fn();
	readonly carMark = vi.fn(() => ({ kind: 'synced' as const }));

	succeed(car: GarageCar): void {
		const pending = this.mutationOutcome();
		if (pending.status !== 'pending') return;
		this.cars.set([...this.cars().filter((value) => value.id !== car.id), car]);
		this.opened.set(true);
		this.mutationOutcome.set({
			...pending,
			status: 'succeeded',
			operationId: `operation-${pending.requestId}`,
			car,
			retainedLocally: true,
		});
	}

	fail(
		error: Extract<CarWorkspaceMutationOutcome, { status: 'failed' }>['error'],
	): void {
		const pending = this.mutationOutcome();
		if (pending.status === 'pending')
			this.mutationOutcome.set({ ...pending, status: 'failed', error });
	}
}

describe('Car setup route', () => {
	let harness: RouterTestingHarness;

	let http: HttpTestingController;
	let workspace: FakeCarWorkspaceStore;

	beforeEach(async () => {
		workspace = new FakeCarWorkspaceStore();
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
				{ provide: CarWorkspaceStore, useValue: workspace },
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
		expect(workspace.commit).toHaveBeenCalledWith({
			type: 'create',
			input: { name: 'Pending import' },
		});
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
		workspace.succeed({ ...car, id: 'stale-car' });
		harness.detectChanges();
		expect(TestBed.inject(Router).url).toBe('/garage/car-2/setups');
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
		workspace.fail({ kind: 'http', status: 401 });
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Your garage session has expired',
		);

		component.createCar({ name: 'Invalid response', make: '', model: '' });
		workspace.fail({ kind: 'invalid-response' });
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'new car could not be created',
		);

		component.createCar({ name: 'Local failure', make: '', model: '' });
		workspace.fail({ kind: 'local', message: 'Storage failed' });
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'new car could not be created',
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
		expect(workspace.commit).toHaveBeenCalledOnce();
		expect(workspace.commit).toHaveBeenCalledWith({
			type: 'create',
			input: { name: 'Imported buggy', make: 'Associated' },
		});
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Creating the new car',
		);
		workspace.fail({ kind: 'unavailable' });
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'The new car could not be created',
		);

		component.createCar(identity);
		workspace.succeed({ ...car, id: 'car-2', name: 'Imported buggy' });
		let carRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			carRefresh = http.expectOne('/api/v1/cars/car-2');
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

	it('uses the local workspace when import lookup is offline and handles child creation', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne('/api/v1/cars')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
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
		expect(workspace.commit).toHaveBeenCalledWith({
			type: 'create',
			input: { name: 'Imported car' },
		});
		workspace.fail({ kind: 'unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'new car could not be created',
		);
	});

	it('shows and retries the live import lookup before a workspace is available', async () => {
		workspace.observeServerCars.mockImplementationOnce(() => undefined);
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
	});

	it('does not claim setup-import creation when workspace mutations are unavailable', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http.expectOne('/api/v1/cars').flush({ cars: [car] });
		let setups: TestRequest | undefined;
		await vi.waitFor(() => {
			setups = http.expectOne('/api/v1/cars/car-1/setups');
		});
		setups?.flush({ setups: [] });
		workspace.mutationsAvailable.set(false);
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			createAction: () => boolean;
			createCar(identity: { name: string; make: string; model: string }): void;
		};
		component.createCar({ name: 'Blocked', make: '', model: '' });
		expect(component.createAction()).toBe(false);
		expect(workspace.commit).not.toHaveBeenCalled();

		workspace.mutationsAvailable.set(true);
		workspace.mutationOutcome.set({
			status: 'pending',
			requestId: 99,
			command: { type: 'create', input: { name: 'Another workflow' } },
		});
		component.createCar({ name: 'Still blocked', make: '', model: '' });
		expect(workspace.commit).not.toHaveBeenCalled();
		expect(component.createAction()).toBe(false);

		workspace.mutationOutcome.set({ status: 'idle', requestId: null });
		workspace.preserveCommandIdentity = false;
		component.createCar({ name: 'Uncorrelated', make: '', model: '' });
		expect(workspace.commit).toHaveBeenCalledOnce();
		expect(component.createAction()).toBe(false);
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
		expect(workspace.commit).toHaveBeenLastCalledWith({
			type: 'create',
			input: { name: 'B7', model: 'B7' },
		});
		await open('car-2');
		workspace.succeed({ ...car, id: 'created-1' });
		harness.detectChanges();
		expect(TestBed.inject(Router).url).toBe('/garage/car-2/setups');

		component.createCar({ name: 'Second', make: '', model: '' });
		expect(workspace.commit).toHaveBeenLastCalledWith({
			type: 'create',
			input: { name: 'Second' },
		});
		await open('car-3');
		workspace.fail({ kind: 'unavailable' });
		expect(TestBed.inject(Router).url).toBe('/garage/car-3/setups');
	});
});
