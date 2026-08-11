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
import { OfflineConnectivity } from '../offline/offline-connectivity';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import type { CarWorkspaceMutationFailure } from './car-sync/car-workspace-store';
import { CarWorkspaceStore } from './car-sync/car-workspace-store';
import type {
	CreateCarCommand,
	GarageCreateOutcome,
	GarageGatewayFailure,
} from './garage.models';
import { GarageGateway } from './garage-gateway';

export type { GarageCar, GarageCarInput } from './garage.models';

type GarageState = { showArchived: boolean };

const collectionErrorMessage = (
	failure: GarageGatewayFailure | null,
): string => {
	if (failure?.kind === 'http' && failure.status === 401)
		return 'Your garage session has expired. Sign in again to continue.';
	return failure
		? 'The garage could not be loaded. Check the connection and try again.'
		: '';
};

const gatewayMutationError = (failure: GarageGatewayFailure): string =>
	failure.kind === 'http' && failure.status === 401
		? 'Your garage session has expired. Sign in again to continue.'
		: 'The car could not be saved. Check the details and try again.';

const mutationErrorMessage = (failure: CarWorkspaceMutationFailure): string => {
	if (failure.kind === 'local') return failure.message;
	if (failure.kind === 'needs-attention' || failure.kind === 'conflict')
		return failure.feedback.message;
	return gatewayMutationError(failure);
};

const legacyFailure = (
	failure: CarWorkspaceMutationFailure,
): GarageGatewayFailure =>
	failure.kind === 'http' ||
	failure.kind === 'unavailable' ||
	failure.kind === 'invalid-response'
		? failure
		: { kind: 'invalid-response' };

export const GarageStore = signalStore(
	withState<GarageState>({ showArchived: false }),
	withProps(() => ({
		gateway: inject(GarageGateway),
		connectivity: inject(OfflineConnectivity),
		offline: inject(OfflineWorkspaceStore),
		workspace: inject(CarWorkspaceStore),
	})),
	withComputed((store) => {
		const createOutcome = computed<GarageCreateOutcome>(() => {
			const outcome = store.workspace.mutationOutcome();
			if (outcome.status === 'idle' || outcome.command.type !== 'create')
				return { status: 'idle', operationId: null };
			if (outcome.status === 'pending')
				return { status: 'pending', operationId: outcome.requestId };
			if (outcome.status === 'succeeded')
				return {
					status: 'succeeded',
					operationId: outcome.requestId,
					car: outcome.car,
				};
			return {
				status: 'failed',
				operationId: outcome.requestId,
				error: legacyFailure(outcome.error),
			};
		});
		return {
			createOutcome,
			cars: computed(() => {
				const cars = store.workspace.opened()
					? store.workspace.cars()
					: store.gateway.collection.hasValue()
						? store.gateway.collection.value().cars
						: store.offline.hasSnapshot()
							? store.offline.cars()
							: [];
				return cars.filter((car) => store.showArchived() || !car.archivedAt);
			}),
			collectionLoading: computed(
				() =>
					!store.workspace.opened() &&
					!store.offline.hasSnapshot() &&
					store.gateway.collection.isLoading(),
			),
			collectionError: computed(() =>
				store.workspace.opened() || store.offline.hasSnapshot()
					? ''
					: collectionErrorMessage(store.gateway.collectionFailure()),
			),
			carAction: computed(() =>
				createOutcome().status === 'pending' ? ('create' as const) : null,
			),
			carMutationsAvailable: store.workspace.mutationsAvailable,
			carMutationError: computed(() => {
				const outcome = store.workspace.mutationOutcome();
				return outcome.status === 'failed' && outcome.command.type === 'create'
					? mutationErrorMessage(outcome.error)
					: '';
			}),
			carMessage: computed(() => {
				const outcome = store.workspace.mutationOutcome();
				if (outcome.status !== 'succeeded' || outcome.command.type !== 'create')
					return '';
				return outcome.retainedLocally && store.workspace.operations().length
					? 'Car saved locally. Pending sync.'
					: 'Car added to the garage.';
			}),
			syncMark: store.workspace.syncMark,
			syncFeedback: computed(() => {
				const mark = store.workspace.syncMark();
				return mark.kind === 'needs-attention' ? mark.feedback.message : '';
			}),
		};
	}),
	withHooks({
		onInit(store) {
			effect(() => {
				const failure = store.gateway.collectionFailure();
				if (store.gateway.collectionUnavailable()) {
					store.offline.markOffline();
					store.connectivity.scheduleRetry();
					return;
				}
				if (failure) {
					store.offline.markOnline();
					store.connectivity.markRequestSucceeded();
					return;
				}
				if (
					store.gateway.collection.status() === 'resolved' &&
					store.gateway.collection.hasValue()
				) {
					store.offline.markOnline();
					store.connectivity.markRequestSucceeded();
					store.workspace.observeServerCars(
						store.gateway.collection.value().cars,
					);
				}
			});
			let retryHint = store.connectivity.retryHint();
			effect(() => {
				const nextRetryHint = store.connectivity.retryHint();
				if (nextRetryHint !== retryHint) store.gateway.refresh();
				retryHint = nextRetryHint;
			});
		},
	}),
	withMethods((store) => ({
		toggleArchived(): void {
			const showArchived = !store.showArchived();
			patchState(store, { showArchived });
			store.gateway.setShowArchived(showArchived);
		},
		retryCollection(): void {
			store.gateway.refresh();
			store.workspace.retrySync();
		},
		clearCarMutationState(): void {
			store.workspace.clearMutationState();
		},
		createCar({ input }: CreateCarCommand): void {
			if (
				store.workspace.mutationsAvailable() &&
				store.workspace.mutationOutcome().status !== 'pending'
			)
				store.workspace.commit({ type: 'create', input });
		},
		carSyncLabel(carId: string): string {
			const mark = store.workspace.carMark(carId);
			if (mark.kind === 'pending') return 'Pending sync';
			if (mark.kind === 'syncing') return 'Syncing';
			if (mark.kind === 'needs-attention') return 'Needs attention';
			if (mark.kind === 'conflict') return 'Sync conflict';
			return '';
		},
	})),
);
