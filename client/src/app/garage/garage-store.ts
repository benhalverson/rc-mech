import { computed, effect, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withHooks,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, exhaustMap, of, tap } from 'rxjs';
import { OfflineConnectivity } from '../offline/offline-connectivity';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import type {
	CreateCarCommand,
	GarageCreateOutcome,
	GarageGatewayFailure,
} from './garage.models';
import { GarageGateway } from './garage-gateway';

export type { GarageCar, GarageCarInput } from './garage.models';

type GarageState = {
	showArchived: boolean;
	createOutcome: GarageCreateOutcome;
};

const collectionErrorMessage = (
	failure: GarageGatewayFailure | null,
): string => {
	if (failure?.kind === 'http' && failure.status === 401)
		return 'Your garage session has expired. Sign in again to continue.';
	return failure
		? 'The garage could not be loaded. Check the connection and try again.'
		: '';
};

const mutationErrorMessage = (failure: GarageGatewayFailure): string =>
	failure.kind === 'http' && failure.status === 401
		? 'Your garage session has expired. Sign in again to continue.'
		: 'The car could not be saved. Check the details and try again.';

export const GarageStore = signalStore(
	withState<GarageState>({
		showArchived: false,
		createOutcome: { status: 'idle', operationId: null },
	}),
	withProps(() => ({
		gateway: inject(GarageGateway),
		connectivity: inject(OfflineConnectivity),
		offline: inject(OfflineWorkspaceStore),
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => ({
		cars: computed(() =>
			store.gateway.collection.hasValue()
				? store.gateway.collection.value().cars
				: store.offline.hasSnapshot()
					? store.offline
							.cars()
							.filter((car) => store.showArchived() || !car.archivedAt)
					: [],
		),
		collectionLoading: computed(
			() =>
				!store.offline.hasSnapshot() && store.gateway.collection.isLoading(),
		),
		collectionError: computed(() =>
			store.offline.hasSnapshot()
				? ''
				: collectionErrorMessage(store.gateway.collectionFailure()),
		),
		carAction: computed(() =>
			store.createOutcome().status === 'pending' ? ('create' as const) : null,
		),
		carMutationsAvailable: computed(
			() => store.connectivity.online() && !store.offline.networkUnavailable(),
		),
		carMutationError: computed(() => {
			const outcome = store.createOutcome();
			return outcome.status === 'failed'
				? mutationErrorMessage(outcome.error)
				: '';
		}),
		carMessage: computed(() =>
			store.createOutcome().status === 'succeeded'
				? 'Car added to the garage.'
				: '',
		),
	})),
	withHooks({
		onInit(store) {
			effect(() => {
				if (store.gateway.collectionUnavailable()) {
					store.offline.markOffline();
					return;
				}
				if (
					store.connectivity.online() &&
					store.gateway.collection.status() === 'resolved' &&
					store.gateway.collection.hasValue()
				)
					store.offline.markOnline();
			});
			let wasOnline = store.connectivity.online();
			effect(() => {
				const online = store.connectivity.online();
				if (online && !wasOnline) store.gateway.refresh();
				wasOnline = online;
			});
		},
	}),
	withMethods((store) => {
		const create = rxMethod<CreateCarCommand>((commands$) =>
			commands$.pipe(
				exhaustMap(({ input }) => {
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						createOutcome: { status: 'pending', operationId },
					});
					return store.gateway.createCar(input).pipe(
						tap((car) => {
							store.gateway.refresh();
							patchState(store, {
								createOutcome: {
									status: 'succeeded',
									operationId,
									car,
								},
							});
						}),
						catchError((error: GarageGatewayFailure) => {
							patchState(store, {
								createOutcome: { status: 'failed', operationId, error },
							});
							return of(null);
						}),
					);
				}),
			),
		);
		return {
			toggleArchived(): void {
				const showArchived = !store.showArchived();
				patchState(store, { showArchived });
				store.gateway.setShowArchived(showArchived);
			},
			retryCollection(): void {
				store.gateway.refresh();
			},
			clearCarMutationState(): void {
				patchState(store, {
					createOutcome: { status: 'idle', operationId: null },
				});
			},
			createCar(command: CreateCarCommand): void {
				if (!store.carMutationsAvailable()) return;
				create(command);
			},
		};
	}),
);
