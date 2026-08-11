import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineCapabilities } from '../../offline/offline-capabilities';
import { OfflineConnectivity } from '../../offline/offline-connectivity';
import {
	OFFLINE_CURRENT_TIME,
	OFFLINE_OPERATION_ID,
	OfflineGarageStorage,
	type OfflineWorkspaceFence,
} from '../../offline/offline-garage-storage';
import { OfflineWorkspaceStore } from '../../offline/offline-workspace-store';
import type { GarageCar } from '../garage.models';
import type {
	CarSyncOperation,
	CarSyncRemoteOutcome,
	CarSyncView,
} from './car-sync.models';
import { CarSyncGateway } from './car-sync-gateway';
import {
	CarWorkspaceStore,
	carWorkspaceGatewayFailure,
	carWorkspaceLocalFailure,
	carWorkspaceTerminalFailure,
	mergeWorkspaceCars,
	replaceWorkspaceCar,
} from './car-workspace-store';

const localCar = {
	id: 'car-1',
	name: 'Local buggy',
	archivedAt: null,
	version: 2,
} as const;

const operation: CarSyncOperation = {
	operationId: 'operation-1',
	ownerKey: 'owner-1',
	carId: 'car-1',
	command: {
		type: 'car.edit',
		carId: 'car-1',
		baseVersion: 1,
		base: { name: 'Buggy' },
		changes: { name: 'Local buggy' },
	},
	dependencies: [],
	status: 'pending',
	createdAt: '2026-08-11T12:00:00.000Z',
};

const pendingView: CarSyncView = {
	canonicalCars: [{ id: 'car-1', name: 'Buggy', version: 1 }],
	cars: [localCar],
	operations: [operation],
};

const syncedView: CarSyncView = {
	canonicalCars: [localCar],
	cars: [localCar],
	operations: [],
};

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
};

class FakeStorage {
	readonly carSyncView = vi.fn(async (): Promise<CarSyncView | null> => null);
	readonly commitCar = vi.fn(
		async (_command?: unknown, _fence?: OfflineWorkspaceFence) => ({
			operation,
			car: localCar,
			view: pendingView,
		}),
	);
	readonly readyCarOperations = vi.fn(
		async (): Promise<readonly CarSyncOperation[]> => [],
	);
	readonly recordCarOutcome = vi.fn(
		async (): Promise<CarSyncView> => syncedView,
	);
	readonly mergeCars = vi.fn(
		async (
			_cars?: readonly GarageCar[],
			_fence?: OfflineWorkspaceFence,
		): Promise<CarSyncView> => syncedView,
	);
}

class FakeGateway {
	private response = new Subject<CarSyncRemoteOutcome>();
	readonly apply = vi.fn(
		(_operation: CarSyncOperation): Observable<CarSyncRemoteOutcome> =>
			this.response.asObservable(),
	);

	succeed(outcome: CarSyncRemoteOutcome): void {
		this.response.next(outcome);
		this.response.complete();
	}

	fail(failure: unknown): void {
		this.response.error(failure);
	}

	reset(): void {
		this.response = new Subject<CarSyncRemoteOutcome>();
	}
}

class FakeOfflineWorkspace {
	readonly ownerKey = signal('owner-1');
	readonly sessionKey = signal('session-1');
	readonly status = signal<
		| 'idle'
		| 'preparing'
		| 'ready'
		| 'offline'
		| 'online-only'
		| 'offline-unavailable'
	>('idle');
	readonly hasSnapshot = signal(false);
	readonly networkUnavailable = signal(false);
	readonly onlineOnlyReason = signal<
		'unsupported' | 'preparation-failed' | null
	>(null);
	readonly markOnline = vi.fn(() => this.networkUnavailable.set(false));
	readonly markOffline = vi.fn(() => this.networkUnavailable.set(true));
	readonly setCars = vi.fn();
}

class FakeConnectivity {
	readonly retryHint = signal(0);
	readonly scheduleRetry = vi.fn();
	readonly markRequestSucceeded = vi.fn();
}

describe('CarWorkspaceStore', () => {
	let storage: FakeStorage;
	let gateway: FakeGateway;
	let offline: FakeOfflineWorkspace;
	let connectivity: FakeConnectivity;
	let operationNumber: number;
	let store: InstanceType<typeof CarWorkspaceStore>;

	beforeEach(() => {
		storage = new FakeStorage();
		gateway = new FakeGateway();
		offline = new FakeOfflineWorkspace();
		connectivity = new FakeConnectivity();
		operationNumber = 10;
		TestBed.configureTestingModule({
			providers: [
				CarWorkspaceStore,
				{ provide: OfflineGarageStorage, useValue: storage },
				{ provide: CarSyncGateway, useValue: gateway },
				{ provide: OfflineWorkspaceStore, useValue: offline },
				{ provide: OfflineConnectivity, useValue: connectivity },
				{ provide: OfflineCapabilities, useValue: { supported: true } },
				{
					provide: OFFLINE_OPERATION_ID,
					useValue: () => `operation-${++operationNumber}`,
				},
				{
					provide: OFFLINE_CURRENT_TIME,
					useValue: () => Date.parse('2026-08-11T12:00:00.000Z'),
				},
			],
		});
		store = TestBed.inject(CarWorkspaceStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('normalizes coordinator failures and immutable Car list updates', () => {
		expect(carWorkspaceGatewayFailure({ kind: 'http', status: 503 })).toEqual({
			kind: 'http',
			status: 503,
		});
		expect(carWorkspaceGatewayFailure({ kind: 'invalid-response' })).toEqual({
			kind: 'invalid-response',
		});
		expect(carWorkspaceGatewayFailure(null)).toEqual({ kind: 'unavailable' });
		expect(carWorkspaceGatewayFailure('offline')).toEqual({
			kind: 'unavailable',
		});
		expect(carWorkspaceLocalFailure(new Error('IndexedDB failed'))).toEqual({
			kind: 'local',
			message: 'IndexedDB failed',
		});
		expect(carWorkspaceLocalFailure('failed')).toEqual({
			kind: 'local',
			message: 'The local Garage could not be updated.',
		});
		expect(
			carWorkspaceTerminalFailure({
				operationId: 'operation-conflict',
				outcome: 'conflict',
				error: { code: 'CONFLICT', message: 'Review both Cars.' },
				remote: { car: { id: 'car-1', name: 'Remote', version: 3 } },
			}),
		).toMatchObject({ kind: 'conflict', remote: { name: 'Remote' } });
		expect(replaceWorkspaceCar([], { id: 'car-1', name: 'One' })).toEqual([
			{ id: 'car-1', name: 'One' },
		]);
		expect(
			replaceWorkspaceCar(
				[
					{ id: 'car-1', name: 'One' },
					{ id: 'car-2', name: 'Two' },
				],
				{ id: 'car-1', name: 'Updated' },
			),
		).toEqual([
			{ id: 'car-1', name: 'Updated' },
			{ id: 'car-2', name: 'Two' },
		]);
		expect(
			mergeWorkspaceCars(
				[{ id: 'car-1', name: 'Old', version: 3 }],
				[
					{ id: 'car-1', name: 'Stale', version: 2 },
					{ id: 'car-1', name: 'Unversioned stale' },
					{ id: 'car-2', name: 'Two' },
				],
			),
		).toEqual([
			{ id: 'car-1', name: 'Old', version: 3 },
			{ id: 'car-2', name: 'Two' },
		]);
		expect(
			mergeWorkspaceCars(
				[{ id: 'car-1', name: 'Old' }],
				[{ id: 'car-1', name: 'New' }],
			),
		).toEqual([{ id: 'car-1', name: 'New' }]);
	});

	it('opens and publishes the durable working copy when preparation completes', async () => {
		storage.carSyncView.mockResolvedValueOnce(pendingView);
		offline.hasSnapshot.set(true);
		offline.status.set('ready');

		await vi.waitFor(() => expect(store.opened()).toBe(true));
		expect(store.cars()).toEqual([localCar]);
		expect(store.operations()).toEqual([operation]);
		expect(store.syncMark()).toEqual({
			kind: 'pending',
			operationIds: ['operation-1'],
		});
		expect(store.carMark('car-1').kind).toBe('pending');
		expect(store.carMark('car-2').kind).toBe('synced');
		expect(offline.setCars).toHaveBeenCalledWith([localCar]);
	});

	it('guards unavailable and overlapping commands and leaves a null open closed', async () => {
		offline.status.set('offline-unavailable');
		store.commit({ type: 'create', input: { name: 'Blocked' } });
		expect(store.mutationOutcome().status).toBe('idle');
		let finishOpen!: (view: CarSyncView | null) => void;
		storage.carSyncView.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishOpen = resolve;
				}),
		);
		store.open();
		store.open();
		await vi.waitFor(() => expect(storage.carSyncView).toHaveBeenCalledOnce());
		finishOpen(null);
		await Promise.resolve();
		expect(store.opened()).toBe(false);

		offline.status.set('online-only');
		offline.networkUnavailable.set(false);
		store.commit({ type: 'create', input: { name: 'Pending' } });
		store.commit({ type: 'create', input: { name: 'Duplicate' } });
		store.clearMutationState();
		expect(gateway.apply).toHaveBeenCalledOnce();
		expect(store.mutationOutcome().status).toBe('pending');
	});

	it('publishes local storage failures from open, queue, acknowledgement, and merge work', async () => {
		storage.carSyncView.mockRejectedValueOnce(new Error('Open failed'));
		store.open();
		await vi.waitFor(() =>
			expect(store.syncFailure()).toEqual({
				kind: 'local',
				message: 'Open failed',
			}),
		);

		storage.carSyncView.mockResolvedValueOnce(syncedView);
		storage.readyCarOperations.mockRejectedValueOnce(
			new Error('Queue read failed'),
		);
		offline.hasSnapshot.set(true);
		offline.status.set('ready');
		await vi.waitFor(() =>
			expect(store.syncFailure()).toEqual({
				kind: 'local',
				message: 'Queue read failed',
			}),
		);

		storage.readyCarOperations.mockResolvedValueOnce([operation]);
		storage.recordCarOutcome.mockRejectedValueOnce(
			new Error('Receipt write failed'),
		);
		store.retrySync();
		await vi.waitFor(() => expect(gateway.apply).toHaveBeenCalledOnce());
		gateway.succeed({
			operationId: operation.operationId,
			outcome: 'applied',
			car: localCar,
		});
		await vi.waitFor(() =>
			expect(store.syncFailure()).toEqual({
				kind: 'local',
				message: 'Receipt write failed',
			}),
		);

		storage.mergeCars.mockRejectedValueOnce('Merge failed');
		store.observeServerCars([{ id: 'car-1', name: 'Server read', version: 3 }]);
		await vi.waitFor(() =>
			expect(store.syncFailure()).toEqual({
				kind: 'local',
				message: 'The local Garage could not be updated.',
			}),
		);
	});

	it('reports local success before acknowledgement and then clears pending work', async () => {
		offline.hasSnapshot.set(true);
		offline.status.set('ready');
		storage.carSyncView.mockResolvedValueOnce(syncedView);
		storage.readyCarOperations
			.mockResolvedValueOnce([operation])
			.mockResolvedValue([]);
		await vi.waitFor(() => expect(store.opened()).toBe(true));

		store.commit({
			type: 'edit',
			carId: 'car-1',
			input: { name: 'Local buggy' },
		});
		await vi.waitFor(() =>
			expect(store.mutationOutcome().status).toBe('succeeded'),
		);
		expect(store.cars()).toEqual([localCar]);
		expect(store.mutationOutcome()).toMatchObject({
			status: 'succeeded',
			operationId: 'operation-1',
			retainedLocally: true,
		});
		expect(store.syncMark().kind).toBe('syncing');

		gateway.succeed({
			operationId: 'operation-1',
			outcome: 'applied',
			car: localCar,
		});
		await vi.waitFor(() => expect(store.syncMark().kind).toBe('synced'));
		expect(storage.recordCarOutcome).toHaveBeenCalledOnce();
		expect(offline.markOnline).toHaveBeenCalledOnce();
	});

	it('opens the complete durable snapshot before merging partial server reads', async () => {
		offline.status.set('preparing');
		store.observeServerCars([
			{ id: 'car-1', name: 'Current Car only', version: 1 },
		]);
		expect(store.opened()).toBe(false);
		expect(store.cars()).toEqual([]);

		storage.carSyncView.mockResolvedValueOnce({
			canonicalCars: [
				{ id: 'car-1', name: 'Current Car', version: 1 },
				{ id: 'car-2', name: 'Second Car', version: 1 },
			],
			cars: [
				{ id: 'car-1', name: 'Current Car', version: 1 },
				{ id: 'car-2', name: 'Second Car', version: 1 },
			],
			operations: [],
		});
		offline.status.set('ready');
		offline.hasSnapshot.set(true);
		await vi.waitFor(() => expect(store.opened()).toBe(true));
		expect(store.cars()).toHaveLength(2);

		storage.mergeCars.mockResolvedValueOnce({
			canonicalCars: [
				{ id: 'car-1', name: 'Current Car refreshed', version: 2 },
				{ id: 'car-2', name: 'Second Car', version: 1 },
			],
			cars: [
				{ id: 'car-1', name: 'Current Car refreshed', version: 2 },
				{ id: 'car-2', name: 'Second Car', version: 1 },
			],
			operations: [],
		});
		store.observeServerCars([
			{ id: 'car-1', name: 'Current Car refreshed', version: 2 },
		]);
		await vi.waitFor(() =>
			expect(store.cars()).toEqual([
				{ id: 'car-1', name: 'Current Car refreshed', version: 2 },
				{ id: 'car-2', name: 'Second Car', version: 1 },
			]),
		);
		expect(storage.mergeCars).toHaveBeenCalledWith(
			[{ id: 'car-1', name: 'Current Car refreshed', version: 2 }],
			{
				ownerKey: 'owner-1',
				sessionKey: 'session-1',
			},
		);
	});

	it('hides one owner workspace immediately and opens only the next session', async () => {
		storage.carSyncView
			.mockResolvedValueOnce(syncedView)
			.mockResolvedValueOnce({
				canonicalCars: [{ id: 'car-b', name: 'Owner B', version: 1 }],
				cars: [{ id: 'car-b', name: 'Owner B', version: 1 }],
				operations: [],
			});
		offline.hasSnapshot.set(true);
		offline.status.set('ready');
		await vi.waitFor(() => expect(store.cars()).toEqual([localCar]));

		offline.ownerKey.set('owner-2');
		offline.sessionKey.set('session-2');
		offline.hasSnapshot.set(false);
		offline.status.set('preparing');
		expect(store.opened()).toBe(false);
		expect(store.cars()).toEqual([]);
		expect(store.operations()).toEqual([]);
		expect(store.syncFailure()).toBeNull();

		offline.hasSnapshot.set(true);
		offline.status.set('ready');
		await vi.waitFor(() =>
			expect(store.cars()).toEqual([
				{ id: 'car-b', name: 'Owner B', version: 1 },
			]),
		);
		expect(storage.carSyncView).toHaveBeenCalledTimes(2);
	});

	it('drops delayed durable opens and server merges after the owner changes', async () => {
		const opening = deferred<CarSyncView | null>();
		storage.carSyncView.mockReturnValueOnce(opening.promise);
		store.open();
		await vi.waitFor(() => expect(storage.carSyncView).toHaveBeenCalledOnce());
		offline.ownerKey.set('owner-2');
		offline.sessionKey.set('session-2');
		opening.resolve(pendingView);
		await Promise.resolve();
		expect(store.opened()).toBe(false);
		expect(offline.setCars).not.toHaveBeenCalled();

		storage.carSyncView.mockResolvedValueOnce(syncedView);
		offline.hasSnapshot.set(true);
		offline.status.set('ready');
		await vi.waitFor(() => expect(store.opened()).toBe(true));
		const merging = deferred<CarSyncView>();
		const failingMerge = deferred<CarSyncView>();
		storage.mergeCars
			.mockReturnValueOnce(merging.promise)
			.mockReturnValueOnce(failingMerge.promise);
		store.observeServerCars([{ id: 'car-1', name: 'Delayed', version: 3 }]);
		store.observeServerCars([
			{ id: 'car-1', name: 'Delayed failure', version: 4 },
		]);
		offline.hasSnapshot.set(false);
		offline.status.set('preparing');
		offline.ownerKey.set('owner-3');
		offline.sessionKey.set('session-3');
		merging.resolve({
			canonicalCars: [{ id: 'car-1', name: 'Delayed', version: 3 }],
			cars: [{ id: 'car-1', name: 'Delayed', version: 3 }],
			operations: [],
		});
		failingMerge.reject(new Error('Stale merge failure'));
		await Promise.resolve();
		expect(store.cars()).toEqual([]);
	});

	it('abandons a sync whose durable queue read crosses an owner change', async () => {
		const ready = deferred<readonly CarSyncOperation[]>();
		storage.carSyncView.mockResolvedValueOnce(pendingView);
		storage.readyCarOperations.mockReturnValueOnce(ready.promise);
		offline.hasSnapshot.set(true);
		offline.status.set('ready');
		await vi.waitFor(() =>
			expect(storage.readyCarOperations).toHaveBeenCalledOnce(),
		);
		offline.hasSnapshot.set(false);
		offline.status.set('preparing');
		offline.ownerKey.set('owner-2');
		offline.sessionKey.set('session-2');
		ready.resolve([operation]);
		await Promise.resolve();
		expect(gateway.apply).not.toHaveBeenCalled();
		expect(store.cars()).toEqual([]);
	});

	it.each(['success', 'failure'] as const)(
		'ignores stale sync gateway %s after an owner change',
		async (result) => {
			storage.carSyncView.mockResolvedValueOnce(pendingView);
			storage.readyCarOperations.mockResolvedValueOnce([operation]);
			offline.hasSnapshot.set(true);
			offline.status.set('ready');
			await vi.waitFor(() => expect(gateway.apply).toHaveBeenCalledOnce());
			offline.hasSnapshot.set(false);
			offline.status.set('preparing');
			offline.ownerKey.set('owner-2');
			offline.sessionKey.set('session-2');
			if (result === 'success')
				gateway.succeed({
					operationId: 'operation-1',
					outcome: 'applied',
					car: localCar,
				});
			else gateway.fail({ kind: 'unavailable' });
			await Promise.resolve();
			expect(storage.recordCarOutcome).not.toHaveBeenCalled();
			expect(store.syncFailure()).toBeNull();
		},
	);

	it.each(['success', 'failure'] as const)(
		'ignores stale online-only commit %s after an owner change',
		async (result) => {
			offline.status.set('online-only');
			store.commit({ type: 'create', input: { name: 'Owner A Car' } });
			await vi.waitFor(() => expect(gateway.apply).toHaveBeenCalledOnce());
			offline.status.set('preparing');
			offline.ownerKey.set('owner-2');
			offline.sessionKey.set('session-2');
			if (result === 'success')
				gateway.succeed({
					operationId: 'operation-11',
					outcome: 'applied',
					car: { id: 'car-a', name: 'Owner A Car', version: 1 },
				});
			else gateway.fail({ kind: 'unavailable' });
			await Promise.resolve();
			expect(store.mutationOutcome().status).toBe('idle');
			expect(store.cars()).toEqual([]);
		},
	);

	it.each(['success', 'failure'] as const)(
		'ignores stale durable commit %s after an owner change',
		async (result) => {
			const committing =
				deferred<Awaited<ReturnType<FakeStorage['commitCar']>>>();
			storage.carSyncView.mockResolvedValueOnce(syncedView);
			storage.commitCar.mockReturnValueOnce(committing.promise);
			offline.hasSnapshot.set(true);
			offline.status.set('ready');
			await vi.waitFor(() => expect(store.opened()).toBe(true));
			store.commit({ type: 'edit', carId: 'car-1', input: { name: 'Stale' } });
			await vi.waitFor(() => expect(storage.commitCar).toHaveBeenCalledOnce());
			offline.hasSnapshot.set(false);
			offline.status.set('preparing');
			offline.ownerKey.set('owner-2');
			offline.sessionKey.set('session-2');
			if (result === 'success')
				committing.resolve({ operation, car: localCar, view: pendingView });
			else committing.reject(new Error('Owner A storage failure'));
			await Promise.resolve();
			expect(store.mutationOutcome().status).toBe('idle');
			expect(store.cars()).toEqual([]);
		},
	);

	it('keeps durable work pending after a failed request and retries on a browser hint', async () => {
		offline.hasSnapshot.set(true);
		offline.status.set('ready');
		storage.carSyncView.mockResolvedValue(pendingView);
		storage.readyCarOperations.mockResolvedValue([operation]);
		await vi.waitFor(() => expect(store.opened()).toBe(true));
		await vi.waitFor(() => expect(gateway.apply).toHaveBeenCalledOnce());

		gateway.fail({ kind: 'unavailable' });
		await vi.waitFor(() => expect(offline.markOffline).toHaveBeenCalledOnce());
		expect(connectivity.scheduleRetry).toHaveBeenCalledOnce();
		expect(store.syncMark().kind).toBe('pending');
		expect(store.syncFailure()).toEqual({ kind: 'unavailable' });

		gateway.reset();
		storage.readyCarOperations
			.mockResolvedValueOnce([operation])
			.mockResolvedValue([]);
		connectivity.retryHint.update((value) => value + 1);
		await vi.waitFor(() => expect(gateway.apply).toHaveBeenCalledTimes(2));
		gateway.succeed({
			operationId: 'operation-1',
			outcome: 'applied',
			car: localCar,
		});
		await vi.waitFor(() => expect(store.syncMark().kind).toBe('synced'));
		expect(connectivity.markRequestSucceeded).toHaveBeenCalled();
	});

	it('waits for the server in online-only mode and retains exact rejection feedback', async () => {
		offline.status.set('online-only');
		offline.onlineOnlyReason.set('preparation-failed');
		store.commit({ type: 'create', input: { name: 'Online buggy' } });
		expect(store.mutationOutcome().status).toBe('pending');
		await vi.waitFor(() => expect(gateway.apply).toHaveBeenCalledOnce());
		expect(store.cars()).toEqual([]);

		gateway.succeed({
			operationId: 'operation-11',
			outcome: 'rejected',
			error: {
				code: 'CAR_VALIDATION_FAILED',
				message: 'Name is already used.',
			},
		});
		await vi.waitFor(() =>
			expect(store.mutationOutcome().status).toBe('failed'),
		);
		expect(store.mutationOutcome()).toMatchObject({
			error: {
				kind: 'needs-attention',
				feedback: { message: 'Name is already used.' },
			},
		});
		expect(offline.markOnline).toHaveBeenCalledOnce();
	});

	it('retains online-only conflicts and maps reached-server and unknown failures', async () => {
		offline.status.set('online-only');
		store.observeServerCars([{ id: 'car-1', name: 'Original', version: 1 }]);
		store.commit({
			type: 'edit',
			carId: 'car-1',
			input: { name: 'Local' },
		});
		await vi.waitFor(() => expect(gateway.apply).toHaveBeenCalledOnce());
		gateway.succeed({
			operationId: 'operation-11',
			outcome: 'conflict',
			error: { code: 'CONFLICT', message: 'Review both.' },
			remote: { car: { id: 'car-1', name: 'Remote', version: 2 } },
		});
		await vi.waitFor(() =>
			expect(store.mutationOutcome()).toMatchObject({
				status: 'failed',
				error: { kind: 'conflict' },
			}),
		);

		gateway.reset();
		store.commit({ type: 'edit', carId: 'car-1', input: { name: 'Retry' } });
		gateway.fail({ kind: 'http', status: 503 });
		await vi.waitFor(() =>
			expect(store.mutationOutcome()).toMatchObject({
				error: { kind: 'http', status: 503 },
			}),
		);
		expect(offline.markOnline).toHaveBeenCalledTimes(2);

		gateway.reset();
		store.commit({ type: 'edit', carId: 'car-1', input: { name: 'Again' } });
		gateway.fail(new Error('socket closed'));
		await vi.waitFor(() =>
			expect(store.mutationOutcome()).toMatchObject({
				error: { kind: 'unavailable' },
			}),
		);
		expect(offline.markOffline).toHaveBeenCalledOnce();
	});

	it('surfaces local transaction failures and non-network sync failures', async () => {
		offline.hasSnapshot.set(true);
		offline.status.set('ready');
		storage.carSyncView.mockResolvedValueOnce(syncedView);
		await vi.waitFor(() => expect(store.opened()).toBe(true));
		storage.commitCar.mockRejectedValueOnce(
			new Error('IndexedDB quota reached'),
		);
		store.commit({ type: 'edit', carId: 'car-1', input: { name: 'Local' } });
		await vi.waitFor(() =>
			expect(store.mutationOutcome()).toMatchObject({
				error: { kind: 'local', message: 'IndexedDB quota reached' },
			}),
		);
		storage.commitCar.mockRejectedValueOnce('blocked');
		store.commit({ type: 'edit', carId: 'car-1', input: { name: 'Again' } });
		await vi.waitFor(() =>
			expect(store.mutationOutcome()).toMatchObject({
				error: {
					kind: 'local',
					message: 'The Car change could not be saved locally.',
				},
			}),
		);

		storage.readyCarOperations.mockResolvedValue([operation]);
		gateway.reset();
		store.retrySync();
		await vi.waitFor(() => expect(gateway.apply).toHaveBeenCalled());
		gateway.fail({ kind: 'invalid-response' });
		await vi.waitFor(() =>
			expect(store.syncFailure()).toEqual({ kind: 'invalid-response' }),
		);
		expect(offline.markOnline).toHaveBeenCalled();
	});

	it('publishes server success in unsupported online-only browsers', async () => {
		TestBed.resetTestingModule();
		TestBed.configureTestingModule({
			providers: [
				CarWorkspaceStore,
				{ provide: OfflineGarageStorage, useValue: storage },
				{ provide: CarSyncGateway, useValue: gateway },
				{ provide: OfflineWorkspaceStore, useValue: offline },
				{ provide: OfflineConnectivity, useValue: connectivity },
				{ provide: OfflineCapabilities, useValue: { supported: false } },
				{ provide: OFFLINE_OPERATION_ID, useValue: () => 'online-operation' },
				{
					provide: OFFLINE_CURRENT_TIME,
					useValue: () => Date.parse('2026-08-11T12:00:00.000Z'),
				},
			],
		});
		store = TestBed.inject(CarWorkspaceStore);
		offline.status.set('online-only');
		store.observeServerCars([{ id: 'car-1', name: 'Buggy', version: 1 }]);
		store.commit({
			type: 'edit',
			carId: 'car-1',
			input: { name: 'Server saved' },
		});
		await vi.waitFor(() => expect(gateway.apply).toHaveBeenCalledOnce());
		gateway.succeed({
			operationId: 'online-operation',
			outcome: 'applied',
			car: { id: 'car-1', name: 'Server saved', version: 2 },
		});
		await vi.waitFor(() =>
			expect(store.mutationOutcome().status).toBe('succeeded'),
		);
		expect(store.cars()).toMatchObject([
			{ id: 'car-1', name: 'Server saved', version: 2 },
		]);
		expect(store.mutationOutcome()).toMatchObject({ retainedLocally: false });
	});
});
