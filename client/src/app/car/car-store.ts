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
import type { CarWorkspaceMutationFailure } from '../garage/car-sync/car-workspace-store';
import { CarWorkspaceStore } from '../garage/car-sync/car-workspace-store';
import type { GarageCarInput } from '../garage/garage-store';
import { OfflineConnectivity } from '../offline/offline-connectivity';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import type {
	CarGatewayFailure,
	CarLifecycleOutcome,
	CarUpdateOutcome,
} from './car.models';
import { CarGateway } from './car-gateway';
import { type CarReadFailure, carReadFailure } from './car-read-failure';

type CarState = { carId: string | null };

const idleUpdate = (): CarUpdateOutcome => ({
	status: 'idle',
	operationId: null,
});

const idleLifecycle = (): CarLifecycleOutcome => ({
	status: 'idle',
	operationId: null,
	action: null,
});

const carFailure = (
	failure: CarGatewayFailure | null,
): CarReadFailure | null =>
	failure?.kind === 'http' && failure.status === 404
		? {
				message:
					'Car not found. Return to the Garage collection and choose another car.',
				retryable: false,
			}
		: failure
			? carReadFailure(
					failure.kind === 'http' ? { status: failure.status } : failure,
					'The car could not be loaded. Check the connection and try again.',
				)
			: null;

const mutationError = (failure: CarWorkspaceMutationFailure): string => {
	if (failure.kind === 'local') return failure.message;
	if (failure.kind === 'needs-attention' || failure.kind === 'conflict')
		return failure.feedback.message;
	return failure.kind === 'http' && failure.status === 401
		? 'Your garage session has expired. Sign in again to continue.'
		: 'The car could not be saved. Check the details and try again.';
};

const lifecycleMutationError = (
	failure: CarWorkspaceMutationFailure,
	action: 'archive' | 'restore',
): string => {
	if (
		failure.kind === 'local' ||
		failure.kind === 'needs-attention' ||
		failure.kind === 'conflict' ||
		(failure.kind === 'http' && failure.status === 401)
	)
		return mutationError(failure);
	return `The car could not be ${action === 'archive' ? 'archived' : 'restored'}.`;
};

export const CarStore = signalStore(
	withState<CarState>({ carId: null }),
	withProps(() => ({
		gateway: inject(CarGateway),
		workspace: inject(CarWorkspaceStore),
		offline: inject(OfflineWorkspaceStore),
		connectivity: inject(OfflineConnectivity),
	})),
	withComputed((store) => {
		const selectedWorkspaceCar = computed(() => {
			const carId = store.carId();
			return carId
				? (store.workspace.cars().find((car) => car.id === carId) ?? null)
				: null;
		});
		const updateOutcome = computed<CarUpdateOutcome>(() => {
			const outcome = store.workspace.mutationOutcome();
			if (
				outcome.status === 'idle' ||
				outcome.command.type !== 'edit' ||
				outcome.command.carId !== store.carId()
			)
				return idleUpdate();
			if (outcome.status === 'pending')
				return { status: 'pending', operationId: outcome.requestId };
			if (outcome.status === 'succeeded')
				return { status: 'succeeded', operationId: outcome.requestId };
			return {
				status: 'failed',
				operationId: outcome.requestId,
				error:
					outcome.error.kind === 'http' ||
					outcome.error.kind === 'unavailable' ||
					outcome.error.kind === 'invalid-response'
						? outcome.error
						: { kind: 'invalid-response' },
			};
		});
		const lifecycleOutcome = computed<CarLifecycleOutcome>(() => {
			const outcome = store.workspace.mutationOutcome();
			if (
				outcome.status === 'idle' ||
				(outcome.command.type !== 'archive' &&
					outcome.command.type !== 'restore') ||
				outcome.command.carId !== store.carId()
			)
				return idleLifecycle();
			const action = outcome.command.type;
			if (outcome.status === 'pending' || outcome.status === 'succeeded')
				return {
					status: outcome.status,
					operationId: outcome.requestId,
					action,
				};
			return {
				status: 'failed',
				operationId: outcome.requestId,
				action,
				error:
					outcome.error.kind === 'http' ||
					outcome.error.kind === 'unavailable' ||
					outcome.error.kind === 'invalid-response'
						? outcome.error
						: { kind: 'invalid-response' },
			};
		});
		return {
			updateOutcome,
			lifecycleOutcome,
			car: computed(
				() =>
					selectedWorkspaceCar() ??
					(store.gateway.car.hasValue() ? store.gateway.car.value() : null),
			),
			loading: computed(
				() => !selectedWorkspaceCar() && store.gateway.car.isLoading(),
			),
			failure: computed(() =>
				selectedWorkspaceCar() ? null : carFailure(store.gateway.failure()),
			),
			carAction: computed(() =>
				updateOutcome().status === 'pending' ? ('update' as const) : null,
			),
			carMutationError: computed(() => {
				const outcome = store.workspace.mutationOutcome();
				return outcome.status === 'failed' &&
					outcome.command.type === 'edit' &&
					outcome.command.carId === store.carId()
					? mutationError(outcome.error)
					: '';
			}),
			carMessage: computed(() => {
				const outcome = store.workspace.mutationOutcome();
				if (
					outcome.status !== 'succeeded' ||
					outcome.command.type !== 'edit' ||
					outcome.command.carId !== store.carId()
				)
					return '';
				return outcome.retainedLocally && store.workspace.operations().length
					? 'Car details saved locally. Pending sync.'
					: 'Car details saved.';
			}),
			lifecycleAction: computed(() => {
				const outcome = lifecycleOutcome();
				return outcome.status === 'pending' ? outcome.action : null;
			}),
			lifecycleError: computed(() => {
				const outcome = store.workspace.mutationOutcome();
				return outcome.status === 'failed' &&
					(outcome.command.type === 'archive' ||
						outcome.command.type === 'restore') &&
					outcome.command.carId === store.carId()
					? lifecycleMutationError(outcome.error, outcome.command.type)
					: '';
			}),
			mutationsAvailable: store.workspace.mutationsAvailable,
			syncMark: computed(() => {
				return store.workspace.carMark(store.carId() ?? '');
			}),
			syncFeedback: computed(() => {
				const mark = store.workspace.carMark(store.carId() ?? '');
				return mark.kind === 'needs-attention' ? mark.feedback.message : '';
			}),
		};
	}),
	withHooks({
		onInit(store) {
			effect(() => {
				const failure = store.gateway.failure();
				if (failure?.kind === 'unavailable') {
					store.offline.markOffline();
					store.connectivity.scheduleRetry();
					return;
				}
				if (failure) {
					store.offline.markOnline();
					store.connectivity.markRequestSucceeded();
					return;
				}
				if (store.gateway.car.hasValue()) {
					store.offline.markOnline();
					store.connectivity.markRequestSucceeded();
					store.workspace.observeServerCars([store.gateway.car.value()]);
				}
			});
		},
	}),
	withMethods((store) => ({
		selectCar(carId: string): void {
			if (store.carId() === carId) return;
			patchState(store, { carId });
			store.workspace.clearMutationState();
			store.gateway.selectCar(carId);
		},
		retry(): void {
			store.gateway.refresh();
			store.workspace.retrySync();
		},
		clearCarMutationState(): void {
			store.workspace.clearMutationState();
		},
		updateCar(input: Partial<GarageCarInput>): void {
			const carId = store.carId();
			if (
				carId &&
				store.workspace.mutationsAvailable() &&
				store.workspace.mutationOutcome().status !== 'pending'
			)
				store.workspace.commit({ type: 'edit', carId, input });
		},
		changeArchiveState(action: 'archive' | 'restore'): void {
			const carId = store.carId();
			if (
				carId &&
				store.workspace.mutationsAvailable() &&
				store.workspace.mutationOutcome().status !== 'pending'
			)
				store.workspace.commit({ type: action, carId });
		},
	})),
);
