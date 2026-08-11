import { computed, effect, inject, untracked } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withHooks,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { OfflineConnectivity } from '../../offline/offline-connectivity';
import {
	OFFLINE_CURRENT_TIME,
	OFFLINE_OPERATION_ID,
	OfflineGarageStorage,
} from '../../offline/offline-garage-storage';
import { OfflineWorkspaceStore } from '../../offline/offline-workspace-store';
import type { GarageCar } from '../garage.models';
import type {
	CarSyncCommand,
	CarSyncFeedback,
	CarSyncOperation,
	CarSyncRemoteOutcome,
	CarSyncView,
} from './car-sync.models';
import { CarSyncGateway, type CarSyncGatewayFailure } from './car-sync-gateway';
import {
	buildCarSyncOperation,
	carSyncMark,
	materializeCars,
} from './car-sync-rules';

export type CarWorkspaceLocalFailure = Readonly<{
	kind: 'local';
	message: string;
}>;

export type CarWorkspaceSyncFailure =
	| CarSyncGatewayFailure
	| CarWorkspaceLocalFailure;

export type CarWorkspaceMutationFailure =
	| CarSyncGatewayFailure
	| CarWorkspaceLocalFailure
	| Readonly<{ kind: 'needs-attention'; feedback: CarSyncFeedback }>
	| Readonly<{
			kind: 'conflict';
			feedback: CarSyncFeedback;
			remote: GarageCar;
	  }>;

export type CarWorkspaceMutationOutcome =
	| Readonly<{ status: 'idle'; requestId: null }>
	| Readonly<{
			status: 'pending';
			requestId: number;
			command: CarSyncCommand;
	  }>
	| Readonly<{
			status: 'succeeded';
			requestId: number;
			operationId: string;
			command: CarSyncCommand;
			car: GarageCar;
			retainedLocally: boolean;
	  }>
	| Readonly<{
			status: 'failed';
			requestId: number;
			command: CarSyncCommand;
			error: CarWorkspaceMutationFailure;
	  }>;

type CarWorkspaceState = Readonly<{
	view: CarSyncView;
	viewOwnerKey: string;
	viewSessionKey: string;
	workspaceOpened: boolean;
	workspaceMutationOutcome: CarWorkspaceMutationOutcome;
	syncingOperationIds: readonly string[];
	workspaceSyncFailure: CarWorkspaceSyncFailure | null;
}>;

const emptyView = (): CarSyncView => ({
	canonicalCars: [],
	cars: [],
	operations: [],
});

export const replaceWorkspaceCar = (
	cars: readonly GarageCar[],
	updated: GarageCar,
): readonly GarageCar[] =>
	cars.some((car) => car.id === updated.id)
		? cars.map((car) => (car.id === updated.id ? updated : car))
		: [...cars, updated];

export const mergeWorkspaceCars = (
	current: readonly GarageCar[],
	incoming: readonly GarageCar[],
): readonly GarageCar[] => {
	const merged = new Map(current.map((car) => [car.id, car]));
	for (const car of incoming) {
		const existing = merged.get(car.id);
		if (
			existing?.version !== undefined &&
			(car.version === undefined || car.version < existing.version)
		)
			continue;
		merged.set(car.id, car);
	}
	return [...merged.values()];
};

export const carWorkspaceGatewayFailure = (
	error: unknown,
): CarSyncGatewayFailure => {
	if (
		typeof error === 'object' &&
		error !== null &&
		'kind' in error &&
		(error.kind === 'unavailable' ||
			error.kind === 'invalid-response' ||
			error.kind === 'http')
	)
		return error as CarSyncGatewayFailure;
	return { kind: 'unavailable' };
};

export const carWorkspaceLocalFailure = (
	error: unknown,
	fallback = 'The local Garage could not be updated.',
): CarWorkspaceLocalFailure => ({
	kind: 'local',
	message: error instanceof Error ? error.message : fallback,
});

export const carWorkspaceTerminalFailure = (
	outcome: Exclude<CarSyncRemoteOutcome, { outcome: 'applied' }>,
): CarWorkspaceMutationFailure =>
	outcome.outcome === 'rejected'
		? { kind: 'needs-attention', feedback: outcome.error }
		: {
				kind: 'conflict',
				feedback: outcome.error,
				remote: outcome.remote.car,
			};

export const CarWorkspaceStore = signalStore(
	{ providedIn: 'root' },
	withState<CarWorkspaceState>({
		view: emptyView(),
		viewOwnerKey: '',
		viewSessionKey: '',
		workspaceOpened: false,
		workspaceMutationOutcome: { status: 'idle', requestId: null },
		syncingOperationIds: [],
		workspaceSyncFailure: null,
	}),
	withProps(() => {
		const offline = inject(OfflineWorkspaceStore);
		return {
			storage: inject(OfflineGarageStorage),
			gateway: inject(CarSyncGateway),
			offline,
			connectivity: inject(OfflineConnectivity),
			nextOperationId: inject(OFFLINE_OPERATION_ID),
			now: inject(OFFLINE_CURRENT_TIME),
			requestSequence: { value: 0 },
			opening: { value: false },
			synchronizing: { value: false },
			identity: {
				ownerKey: offline.ownerKey(),
				sessionKey: offline.sessionKey(),
				generation: 0,
			},
		};
	}),
	withComputed((store) => {
		const identityMatches = computed(
			() =>
				store.viewOwnerKey() === store.offline.ownerKey() &&
				store.viewSessionKey() === store.offline.sessionKey(),
		);
		const opened = computed(() => identityMatches() && store.workspaceOpened());
		const operations = computed(() =>
			opened() ? store.view().operations : [],
		);
		return {
			opened,
			cars: computed(() => (opened() ? store.view().cars : [])),
			operations,
			mutationOutcome: computed<CarWorkspaceMutationOutcome>(() =>
				identityMatches()
					? store.workspaceMutationOutcome()
					: { status: 'idle', requestId: null },
			),
			syncFailure: computed(() =>
				identityMatches() ? store.workspaceSyncFailure() : null,
			),
			syncMark: computed(() =>
				carSyncMark(operations(), new Set(store.syncingOperationIds())),
			),
			mutationsAvailable: computed(() => {
				const status = store.offline.status();
				return (
					store.offline.hasSnapshot() ||
					(status === 'online-only' && !store.offline.networkUnavailable())
				);
			}),
		};
	}),
	withMethods((store) => {
		const isCurrentGeneration = (generation: number): boolean =>
			store.identity.generation === generation &&
			store.identity.ownerKey === store.offline.ownerKey() &&
			store.identity.sessionKey === store.offline.sessionKey();
		const publishView = (view: CarSyncView, generation: number): void => {
			if (!isCurrentGeneration(generation)) return;
			patchState(store, {
				view,
				viewOwnerKey: store.offline.ownerKey(),
				viewSessionKey: store.offline.sessionKey(),
				workspaceOpened: true,
				workspaceSyncFailure: null,
			});
			store.offline.setCars(view.cars);
		};
		const publishLocalSyncFailure = (
			error: unknown,
			generation: number,
		): void => {
			if (!isCurrentGeneration(generation)) return;
			patchState(store, {
				viewOwnerKey: store.offline.ownerKey(),
				viewSessionKey: store.offline.sessionKey(),
				workspaceSyncFailure: carWorkspaceLocalFailure(error),
			});
		};

		const runSync = async (
			generation = store.identity.generation,
		): Promise<void> => {
			if (
				!isCurrentGeneration(generation) ||
				store.synchronizing.value ||
				!store.offline.hasSnapshot()
			)
				return;
			store.synchronizing.value = true;
			try {
				for (;;) {
					const [operation] = await store.storage.readyCarOperations();
					if (!isCurrentGeneration(generation)) return;
					if (!operation) break;
					patchState(store, {
						syncingOperationIds: [operation.operationId],
						workspaceSyncFailure: null,
					});
					let outcome: CarSyncRemoteOutcome;
					try {
						outcome = await firstValueFrom(store.gateway.apply(operation));
					} catch (error) {
						if (!isCurrentGeneration(generation)) return;
						const failure = carWorkspaceGatewayFailure(error);
						if (failure.kind === 'unavailable') {
							store.offline.markOffline();
							store.connectivity.scheduleRetry();
						} else {
							store.offline.markOnline();
							store.connectivity.markRequestSucceeded();
						}
						patchState(store, {
							syncingOperationIds: [],
							workspaceSyncFailure: failure,
						});
						return;
					}
					if (!isCurrentGeneration(generation)) return;
					store.offline.markOnline();
					store.connectivity.markRequestSucceeded();
					const view = await store.storage.recordCarOutcome(outcome);
					publishView(view, generation);
					patchState(store, { syncingOperationIds: [] });
				}
			} catch (error) {
				publishLocalSyncFailure(error, generation);
			} finally {
				if (isCurrentGeneration(generation)) {
					store.synchronizing.value = false;
					patchState(store, { syncingOperationIds: [] });
				}
			}
		};

		const open = async (): Promise<void> => {
			if (store.opening.value) return;
			const generation = store.identity.generation;
			store.opening.value = true;
			try {
				const view = await store.storage.carSyncView();
				if (view && isCurrentGeneration(generation)) {
					publishView(view, generation);
					void runSync(generation);
				}
			} catch (error) {
				publishLocalSyncFailure(error, generation);
			} finally {
				if (isCurrentGeneration(generation)) store.opening.value = false;
			}
		};

		const commitOnlineOnly = async (
			command: CarSyncCommand,
			requestId: number,
			generation: number,
		): Promise<void> => {
			const operationId = store.nextOperationId();
			const built = buildCarSyncOperation(command, untracked(store.cars), [], {
				ownerKey: store.offline.ownerKey(),
				operationId,
				carId: command.type === 'create' ? store.nextOperationId() : undefined,
				createdAt: new Date(store.now()).toISOString(),
			});
			try {
				const outcome = await firstValueFrom(
					store.gateway.apply(built.operation),
				);
				if (!isCurrentGeneration(generation)) return;
				store.offline.markOnline();
				store.connectivity.markRequestSucceeded();
				if (outcome.outcome !== 'applied') {
					patchState(store, {
						workspaceMutationOutcome: {
							status: 'failed',
							requestId,
							command,
							error: carWorkspaceTerminalFailure(outcome),
						},
					});
					return;
				}
				const canonicalCars = replaceWorkspaceCar(
					untracked(store.view).canonicalCars,
					outcome.car,
				);
				publishView(
					{
						canonicalCars,
						cars: canonicalCars,
						operations: [],
					},
					generation,
				);
				patchState(store, {
					workspaceMutationOutcome: {
						status: 'succeeded',
						requestId,
						operationId,
						command,
						car: outcome.car,
						retainedLocally: false,
					},
				});
			} catch (error) {
				if (!isCurrentGeneration(generation)) return;
				const failure = carWorkspaceGatewayFailure(error);
				if (failure.kind === 'unavailable') {
					store.offline.markOffline();
					store.connectivity.scheduleRetry();
				} else {
					store.offline.markOnline();
					store.connectivity.markRequestSucceeded();
				}
				patchState(store, {
					workspaceMutationOutcome: {
						status: 'failed',
						requestId,
						command,
						error: failure,
					},
				});
			}
		};

		const commitDurable = async (
			command: CarSyncCommand,
			requestId: number,
			generation: number,
		): Promise<void> => {
			try {
				const committed = await store.storage.commitCar(command, {
					ownerKey: store.identity.ownerKey,
					sessionKey: store.identity.sessionKey,
				});
				if (!isCurrentGeneration(generation)) return;
				publishView(committed.view, generation);
				patchState(store, {
					workspaceMutationOutcome: {
						status: 'succeeded',
						requestId,
						operationId: committed.operation.operationId,
						command,
						car: committed.car,
						retainedLocally: true,
					},
				});
				void runSync(generation);
			} catch (error) {
				if (!isCurrentGeneration(generation)) return;
				patchState(store, {
					workspaceMutationOutcome: {
						status: 'failed',
						requestId,
						command,
						error: carWorkspaceLocalFailure(
							error,
							'The Car change could not be saved locally.',
						),
					},
				});
			}
		};

		return {
			open(): void {
				void open();
			},
			observeServerCars(cars: readonly GarageCar[]): void {
				if (!store.opened() && store.offline.status() !== 'online-only') return;
				const generation = store.identity.generation;
				if (store.offline.hasSnapshot()) {
					void store.storage
						.mergeCars(cars, {
							ownerKey: store.identity.ownerKey,
							sessionKey: store.identity.sessionKey,
						})
						.then((view) => publishView(view, generation))
						.catch((error: unknown) =>
							publishLocalSyncFailure(error, generation),
						);
					return;
				}
				const current = untracked(store.view);
				const canonicalCars = mergeWorkspaceCars(current.canonicalCars, cars);
				publishView(
					{
						canonicalCars,
						cars: materializeCars(canonicalCars, current.operations),
						operations: current.operations,
					},
					generation,
				);
			},
			commit(command: CarSyncCommand): void {
				if (
					!isCurrentGeneration(store.identity.generation) ||
					!untracked(store.mutationsAvailable) ||
					untracked(store.mutationOutcome).status === 'pending'
				)
					return;
				const requestId = ++store.requestSequence.value;
				const generation = store.identity.generation;
				patchState(store, {
					viewOwnerKey: store.offline.ownerKey(),
					viewSessionKey: store.offline.sessionKey(),
					workspaceMutationOutcome: { status: 'pending', requestId, command },
				});
				if (store.offline.hasSnapshot())
					void commitDurable(command, requestId, generation);
				else void commitOnlineOnly(command, requestId, generation);
			},
			clearMutationState(): void {
				if (untracked(store.mutationOutcome).status !== 'pending')
					patchState(store, {
						workspaceMutationOutcome: { status: 'idle', requestId: null },
					});
			},
			retrySync(): void {
				void runSync();
			},
			carMark(carId: string) {
				return carSyncMark(
					store
						.operations()
						.filter((operation: CarSyncOperation) => operation.carId === carId),
					new Set(store.syncingOperationIds()),
				);
			},
		};
	}),
	withHooks({
		onInit(store) {
			effect(() => {
				const ownerKey = store.offline.ownerKey();
				const sessionKey = store.offline.sessionKey();
				if (
					ownerKey === store.identity.ownerKey &&
					sessionKey === store.identity.sessionKey
				)
					return;
				store.identity.ownerKey = ownerKey;
				store.identity.sessionKey = sessionKey;
				store.identity.generation += 1;
				store.opening.value = false;
				store.synchronizing.value = false;
				patchState(store, {
					view: emptyView(),
					viewOwnerKey: ownerKey,
					viewSessionKey: sessionKey,
					workspaceOpened: false,
					workspaceMutationOutcome: { status: 'idle', requestId: null },
					syncingOperationIds: [],
					workspaceSyncFailure: null,
				});
			});
			effect(() => {
				if (store.offline.hasSnapshot() && !store.opened()) store.open();
			});
			let retryHint = store.connectivity.retryHint();
			effect(() => {
				const nextRetryHint = store.connectivity.retryHint();
				if (nextRetryHint !== retryHint) store.retrySync();
				retryHint = nextRetryHint;
			});
		},
	}),
);
