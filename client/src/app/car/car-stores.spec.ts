import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	CarSyncCommand,
	CarSyncMark,
	CarSyncOperation,
} from '../garage/car-sync/car-sync.models';
import {
	type CarWorkspaceMutationOutcome,
	CarWorkspaceStore,
} from '../garage/car-sync/car-workspace-store';
import type { GarageCar } from '../garage/garage.models';
import { GarageGateway } from '../garage/garage-gateway';
import { OfflineConnectivity } from '../offline/offline-connectivity';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import type {
	CarGatewayFailure,
	ChangeCarLifecycleCommand,
	UpdateCarCommand,
} from './car.models';
import { CarBuildGateway } from './car-build-gateway';
import { CarBuildStore } from './car-build-store';
import { CarGateway } from './car-gateway';
import { carReadFailure } from './car-read-failure';
import { CarStore } from './car-store';
import { CarSetupsStore } from './setups/car-setups-store';

const car = (overrides: Partial<GarageCar> = {}): GarageCar => ({
	id: 'car-1',
	name: 'One',
	...overrides,
});

class FakeCarGateway {
	private readonly carValue = signal<GarageCar | undefined>(undefined);
	private readonly carLoading = signal(false);
	private readonly readFailure = signal<CarGatewayFailure | null>(null);
	private updateResult = new Subject<GarageCar>();
	private lifecycleResult = new Subject<GarageCar>();

	readonly car = {
		hasValue: () => this.carValue() !== undefined,
		value: () => this.carValue() as GarageCar,
		isLoading: this.carLoading,
	};
	readonly selectCar = vi.fn();
	readonly failure = vi.fn(() => this.readFailure());
	readonly refresh = vi.fn();
	readonly updateCar = vi.fn(
		(_command: UpdateCarCommand): Observable<GarageCar> =>
			this.updateResult.asObservable(),
	);
	readonly changeLifecycle = vi.fn(
		(_command: ChangeCarLifecycleCommand): Observable<GarageCar> =>
			this.lifecycleResult.asObservable(),
	);

	setCar(value: GarageCar | undefined): void {
		this.carValue.set(value);
	}

	setLoading(value: boolean): void {
		this.carLoading.set(value);
	}

	setFailure(value: CarGatewayFailure | null): void {
		this.readFailure.set(value);
	}

	succeedUpdate(value = car()): void {
		this.updateResult.next(value);
		this.updateResult.complete();
	}

	failUpdate(failure: CarGatewayFailure): void {
		this.updateResult.error(failure);
	}

	resetUpdate(): void {
		this.updateResult = new Subject<GarageCar>();
	}

	succeedLifecycle(value = car()): void {
		this.lifecycleResult.next(value);
		this.lifecycleResult.complete();
	}

	failLifecycle(failure: CarGatewayFailure): void {
		this.lifecycleResult.error(failure);
	}

	resetLifecycle(): void {
		this.lifecycleResult = new Subject<GarageCar>();
	}
}

class FakeCarWorkspace {
	readonly cars = signal<readonly GarageCar[]>([]);
	readonly operations = signal<readonly CarSyncOperation[]>([]);
	readonly mutationsAvailable = signal(true);
	readonly mark = signal<CarSyncMark>({ kind: 'synced' });
	readonly mutationOutcome = signal<CarWorkspaceMutationOutcome>({
		status: 'idle',
		requestId: null,
	});
	private requestId = 0;
	readonly commit = vi.fn((command: CarSyncCommand) => {
		if (this.mutationOutcome().status === 'pending') return;
		this.mutationOutcome.set({
			status: 'pending',
			requestId: ++this.requestId,
			command,
		});
	});
	readonly clearMutationState = vi.fn(() => {
		if (this.mutationOutcome().status !== 'pending')
			this.mutationOutcome.set({ status: 'idle', requestId: null });
	});
	readonly observeServerCars = vi.fn((cars: readonly GarageCar[]) =>
		this.cars.set(cars),
	);
	readonly retrySync = vi.fn();
	readonly carMark = vi.fn(() => this.mark());

	succeed(car: GarageCar, retainedLocally = false): void {
		const pending = this.mutationOutcome();
		if (pending.status !== 'pending') return;
		this.cars.set([...this.cars().filter((value) => value.id !== car.id), car]);
		this.mutationOutcome.set({
			...pending,
			status: 'succeeded',
			operationId: `operation-${pending.requestId}`,
			car,
			retainedLocally,
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

const fakeOfflineWorkspace = {
	markOnline: vi.fn(),
	markOffline: vi.fn(),
};

const fakeConnectivity = {
	scheduleRetry: vi.fn(),
	markRequestSucceeded: vi.fn(),
};

describe('car route stores', () => {
	let http: HttpTestingController | undefined;

	const configure = (store: unknown): void => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				CarBuildGateway,
				CarGateway,
				GarageGateway,
				store,
			],
		});
		http = TestBed.inject(HttpTestingController);
	};

	const configureCarStore = (): {
		gateway: FakeCarGateway;
		workspace: FakeCarWorkspace;
		store: InstanceType<typeof CarStore>;
	} => {
		const gateway = new FakeCarGateway();
		const workspace = new FakeCarWorkspace();
		TestBed.configureTestingModule({
			providers: [
				CarStore,
				{ provide: CarGateway, useValue: gateway },
				{ provide: CarWorkspaceStore, useValue: workspace },
				{ provide: OfflineWorkspaceStore, useValue: fakeOfflineWorkspace },
				{ provide: OfflineConnectivity, useValue: fakeConnectivity },
			],
		});
		return { gateway, workspace, store: TestBed.inject(CarStore) };
	};

	afterEach(() => {
		try {
			http?.verify();
		} finally {
			http = undefined;
			vi.unstubAllGlobals();
			TestBed.resetTestingModule();
		}
	});

	it('groups build history and exposes both reload methods', async () => {
		configure(CarBuildStore);
		const store = TestBed.inject(CarBuildStore);
		expect(store.components()).toEqual([]);
		expect(store.groups()).toEqual([]);

		store.selectCar('car-1');
		store.selectCar('car-1');
		await vi.waitFor(() =>
			http?.expectOne('/api/v1/cars/car-1/components?history=true').flush({
				components: [
					{
						id: 'component-current',
						carId: 'car-1',
						slot: 'motor',
						name: 'Current',
					},
					{
						id: 'component-old',
						carId: 'car-1',
						slot: 'motor',
						name: 'Old',
						installedAt: 'invalid',
						removedAt: '2026-01-01T00:00:00.000Z',
					},
				],
			}),
		);
		expect(store.groups()[0]?.current?.id).toBe('component-current');
		expect(store.groups()[0]?.history).toHaveLength(1);

		store.retry();
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-1/components?history=true')
				.flush({ components: [] }),
		);
		store.refresh();
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-1/components?history=true')
				.flush({ components: [] }),
		);
	});

	it('guards build saves and ignores stale success after route reuse', async () => {
		configure(CarBuildStore);
		const store = TestBed.inject(CarBuildStore);
		const save = {
			mode: 'add' as const,
			componentId: null,
			input: { slot: 'motor', name: 'Race motor' },
		};
		store.save(save);
		http?.expectNone((request) => request.method === 'POST');

		store.selectCar('car-1');
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-1/components?history=true')
				.flush({ components: [] }),
		);
		store.save(save);
		store.save(save);
		const pending = http?.expectOne('/api/v1/cars/car-1/components');
		store.selectCar('car-2');
		pending?.flush({
			component: {
				id: 'component-1',
				carId: 'car-1',
				slot: 'motor',
				name: 'Race motor',
			},
		});
		await vi.waitFor(() =>
			http
				?.expectOne('/api/v1/cars/car-2/components?history=true')
				.flush({ components: [] }),
		);
		expect(store.outcome().status).toBe('idle');
	});

	it('uses setup collection defaults and exposes both reload methods', async () => {
		configure(CarSetupsStore);
		const store = TestBed.inject(CarSetupsStore);
		expect(store.availableCars()).toEqual([]);
		store.createCar({
			sourceCarId: 'another-car',
			input: { name: 'Ignored import car' },
		});
		http?.expectNone((request) => request.method === 'POST');
		await vi.waitFor(() => http?.expectOne('/api/v1/cars').flush({ cars: [] }));
		store.retry();
		await vi.waitFor(() => http?.expectOne('/api/v1/cars').flush({ cars: [] }));
		store.refresh();
		await vi.waitFor(() => http?.expectOne('/api/v1/cars').flush({ cars: [] }));
	});

	it('publishes current-car resource and mutation success state', () => {
		const { gateway, workspace, store } = configureCarStore();
		expect(store.car()).toBeNull();
		expect(store.loading()).toBe(false);
		expect(store.failure()).toBeNull();
		expect(store.carAction()).toBeNull();
		expect(store.carMutationError()).toBe('');
		expect(store.carMessage()).toBe('');
		expect(store.lifecycleAction()).toBeNull();
		expect(store.lifecycleError()).toBe('');

		gateway.setLoading(true);
		expect(store.loading()).toBe(true);
		gateway.setLoading(false);
		store.selectCar('car-1');
		store.selectCar('car-1');
		expect(gateway.selectCar).toHaveBeenCalledOnce();
		expect(gateway.selectCar).toHaveBeenCalledWith('car-1');
		workspace.cars.set([car({ id: 'another-car' })]);
		expect(store.car()).toBeNull();
		gateway.setCar(car());
		expect(store.car()).toEqual(car());
		workspace.cars.set([car()]);
		gateway.setFailure({ kind: 'http', status: 404 });
		TestBed.flushEffects();
		expect(fakeOfflineWorkspace.markOnline).toHaveBeenCalled();
		expect(fakeConnectivity.markRequestSucceeded).toHaveBeenCalled();
		expect(store.failure()).toBeNull();
		gateway.setFailure(null);

		store.updateCar({ name: 'Updated' });
		expect(workspace.commit).toHaveBeenCalledWith({
			type: 'edit',
			carId: 'car-1',
			input: { name: 'Updated' },
		});
		expect(store.carAction()).toBe('update');
		expect(store.carMutationError()).toBe('');
		expect(store.carMessage()).toBe('');
		workspace.succeed(car({ name: 'Updated' }));
		expect(store.updateOutcome()).toEqual({
			status: 'succeeded',
			operationId: 1,
		});
		expect(store.carAction()).toBeNull();
		expect(store.carMessage()).toBe('Car details saved.');
		store.clearCarMutationState();
		expect(store.carMessage()).toBe('');

		store.changeArchiveState('archive');
		expect(workspace.commit).toHaveBeenLastCalledWith({
			type: 'archive',
			carId: 'car-1',
		});
		expect(store.lifecycleAction()).toBe('archive');
		expect(store.lifecycleError()).toBe('');
		workspace.succeed(car({ name: 'Updated', archivedAt: 'now' }));
		expect(store.lifecycleOutcome()).toEqual({
			status: 'succeeded',
			operationId: 2,
			action: 'archive',
		});
		expect(store.lifecycleAction()).toBeNull();
		expect(store.lifecycleError()).toBe('');
	});

	it('maps car failures and blocks overlapping store commands', () => {
		const { gateway, workspace, store } = configureCarStore();
		expect(carReadFailure('offline', 'Fallback read failure.')).toEqual({
			message: 'Fallback read failure.',
			retryable: true,
		});

		store.updateCar({ name: 'No car' });
		store.changeArchiveState('archive');
		expect(workspace.commit).not.toHaveBeenCalled();

		store.selectCar('missing');
		gateway.setFailure({ kind: 'http', status: 404 });
		expect(store.failure()?.message).toContain('Car not found');
		store.retry();
		expect(gateway.refresh).toHaveBeenCalledOnce();
		expect(workspace.retrySync).toHaveBeenCalledOnce();
		gateway.setFailure({ kind: 'http', status: 503 });
		expect(store.failure()?.message).toContain('could not be loaded');
		gateway.setFailure({ kind: 'invalid-response' });
		expect(store.failure()?.retryable).toBe(true);
		gateway.setFailure(null);
		expect(store.failure()).toBeNull();

		store.selectCar('car-1');
		store.updateCar({ name: 'Expired' });
		workspace.fail({ kind: 'http', status: 401 });
		expect(store.updateOutcome()).toEqual({
			status: 'failed',
			operationId: 1,
			error: { kind: 'http', status: 401 },
		});
		expect(store.carMutationError()).toContain('session has expired');

		store.updateCar({ name: 'Unavailable' });
		workspace.fail({ kind: 'unavailable' });
		expect(store.updateOutcome()).toEqual({
			status: 'failed',
			operationId: 2,
			error: { kind: 'unavailable' },
		});
		expect(store.carMutationError()).toContain('could not be saved');

		store.updateCar({ name: 'Pending update' });
		expect(store.updateOutcome()).toEqual({
			status: 'pending',
			operationId: 3,
		});
		store.changeArchiveState('archive');
		expect(workspace.commit).toHaveBeenCalledTimes(3);
		workspace.succeed(car({ name: 'Pending update' }));

		store.changeArchiveState('archive');
		expect(store.lifecycleOutcome()).toEqual({
			status: 'pending',
			operationId: 4,
			action: 'archive',
		});
		store.updateCar({ name: 'Blocked update' });
		expect(workspace.commit).toHaveBeenCalledTimes(4);
		workspace.fail({ kind: 'http', status: 401 });
		expect(store.lifecycleOutcome()).toEqual({
			status: 'failed',
			operationId: 4,
			action: 'archive',
			error: { kind: 'http', status: 401 },
		});
		expect(store.lifecycleError()).toContain('session has expired');

		store.changeArchiveState('restore');
		workspace.fail({ kind: 'unavailable' });
		expect(store.lifecycleOutcome()).toEqual({
			status: 'failed',
			operationId: 5,
			action: 'restore',
			error: { kind: 'unavailable' },
		});
		expect(store.lifecycleError()).toContain('could not be restored');

		store.changeArchiveState('archive');
		workspace.fail({ kind: 'unavailable' });
		expect(store.lifecycleOutcome()).toEqual({
			status: 'failed',
			operationId: 6,
			action: 'archive',
			error: { kind: 'unavailable' },
		});
		expect(store.lifecycleError()).toContain('could not be archived');
	});

	it('ignores duplicate and stale mutation responses after route reuse', () => {
		const { workspace, store } = configureCarStore();
		store.selectCar('car-1');
		store.updateCar({ name: 'Updated' });
		store.updateCar({ name: 'Duplicate' });
		store.changeArchiveState('archive');
		expect(workspace.commit).toHaveBeenCalledOnce();
		store.selectCar('car-2');
		workspace.succeed(car({ name: 'Updated' }));
		expect(store.updateOutcome().status).toBe('idle');

		store.updateCar({ name: 'Failed' });
		store.selectCar('car-3');
		workspace.fail({ kind: 'unavailable' });
		expect(store.updateOutcome().status).toBe('idle');

		store.changeArchiveState('archive');
		store.changeArchiveState('restore');
		expect(workspace.commit).toHaveBeenCalledTimes(3);
		store.selectCar('car-4');
		workspace.succeed(car({ id: 'car-3', archivedAt: 'now' }));
		expect(store.lifecycleOutcome().status).toBe('idle');

		store.changeArchiveState('archive');
		store.selectCar('car-5');
		workspace.fail({ kind: 'unavailable' });
		expect(store.lifecycleOutcome().status).toBe('idle');
	});

	it('publishes local, validation, conflict, and retained sync state', async () => {
		const { gateway, workspace, store } = configureCarStore();
		expect(store.syncMark()).toEqual({ kind: 'synced' });
		expect(store.syncFeedback()).toBe('');
		workspace.mark.set({
			kind: 'needs-attention',
			operationId: 'operation-attention',
			feedback: { code: 'INVALID', message: 'Correct this Car.' },
		});
		expect(store.syncFeedback()).toBe('Correct this Car.');
		workspace.mutationsAvailable.set(false);
		store.selectCar('car-1');
		store.updateCar({ name: 'Blocked' });
		store.changeArchiveState('archive');
		expect(workspace.commit).not.toHaveBeenCalled();

		workspace.mutationsAvailable.set(true);
		workspace.cars.set([car()]);
		store.updateCar({ name: 'Local failure' });
		workspace.fail({ kind: 'local', message: 'IndexedDB is full.' });
		expect(store.carMutationError()).toBe('IndexedDB is full.');
		expect(store.updateOutcome()).toMatchObject({
			status: 'failed',
			error: { kind: 'invalid-response' },
		});

		store.updateCar({ name: 'Needs attention' });
		workspace.fail({
			kind: 'needs-attention',
			feedback: { code: 'INVALID', message: 'Correct the Car name.' },
		});
		expect(store.carMutationError()).toBe('Correct the Car name.');

		store.updateCar({ name: 'Conflict' });
		workspace.fail({
			kind: 'conflict',
			feedback: { code: 'CONFLICT', message: 'Review both Cars.' },
			remote: car({ name: 'Remote' }),
		});
		expect(store.carMutationError()).toBe('Review both Cars.');

		store.updateCar({ name: 'Retained' });
		workspace.operations.set([
			{
				operationId: 'operation-4',
				ownerKey: 'owner-1',
				carId: 'car-1',
				command: {
					type: 'car.edit',
					carId: 'car-1',
					baseVersion: 1,
					base: { name: 'One' },
					changes: { name: 'Retained' },
				},
				dependencies: [],
				status: 'pending',
				createdAt: '2026-08-11T12:00:00.000Z',
			},
		]);
		workspace.succeed(car({ name: 'Retained' }), true);
		expect(store.carMessage()).toContain('saved locally');

		store.changeArchiveState('archive');
		workspace.fail({ kind: 'local', message: 'Archive was not retained.' });
		expect(store.lifecycleError()).toBe('Archive was not retained.');
		expect(store.lifecycleOutcome()).toMatchObject({
			status: 'failed',
			error: { kind: 'invalid-response' },
		});

		gateway.setFailure({ kind: 'unavailable' });
		await vi.waitFor(() =>
			expect(fakeOfflineWorkspace.markOffline).toHaveBeenCalled(),
		);
	});
});
