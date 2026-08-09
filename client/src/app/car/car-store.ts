import { computed, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, exhaustMap, of, tap } from 'rxjs';
import type { GarageCarInput } from '../garage/garage-store';
import type {
	CarGatewayFailure,
	CarLifecycleOutcome,
	CarUpdateOutcome,
	ChangeCarLifecycleCommand,
	UpdateCarCommand,
} from './car.models';
import { CarGateway } from './car-gateway';
import { type CarReadFailure, carReadFailure } from './car-read-failure';

type CarState = {
	carId: string | null;
	updateOutcome: CarUpdateOutcome;
	lifecycleOutcome: CarLifecycleOutcome;
};

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

const mutationError = (failure: CarGatewayFailure): string =>
	failure.kind === 'http' && failure.status === 401
		? 'Your garage session has expired. Sign in again to continue.'
		: 'The car could not be saved. Check the details and try again.';

export const CarStore = signalStore(
	withState<CarState>({
		carId: null,
		updateOutcome: idleUpdate(),
		lifecycleOutcome: idleLifecycle(),
	}),
	withProps(() => ({
		gateway: inject(CarGateway),
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => ({
		car: computed(() =>
			store.gateway.car.hasValue() ? store.gateway.car.value() : null,
		),
		loading: computed(() => store.gateway.car.isLoading()),
		failure: computed(() => carFailure(store.gateway.failure())),
		carAction: computed(() =>
			store.updateOutcome().status === 'pending' ? ('update' as const) : null,
		),
		carMutationError: computed(() => {
			const outcome = store.updateOutcome();
			return outcome.status === 'failed' ? mutationError(outcome.error) : '';
		}),
		carMessage: computed(() =>
			store.updateOutcome().status === 'succeeded' ? 'Car details saved.' : '',
		),
		lifecycleAction: computed(() => {
			const outcome = store.lifecycleOutcome();
			return outcome.status === 'pending' ? outcome.action : null;
		}),
		lifecycleError: computed(() => {
			const outcome = store.lifecycleOutcome();
			if (outcome.status !== 'failed') return '';
			return outcome.error.kind === 'http' && outcome.error.status === 401
				? 'Your garage session has expired. Sign in again to continue.'
				: `The car could not be ${outcome.action === 'archive' ? 'archived' : 'restored'}.`;
		}),
	})),
	withMethods((store) => {
		const update = rxMethod<UpdateCarCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						updateOutcome: { status: 'pending', operationId },
					});
					return store.gateway.updateCar(command).pipe(
						tap(() => {
							if (store.carId() !== command.carId) return;
							store.gateway.refresh();
							patchState(store, {
								updateOutcome: { status: 'succeeded', operationId },
							});
						}),
						catchError((error: CarGatewayFailure) => {
							if (store.carId() === command.carId)
								patchState(store, {
									updateOutcome: { status: 'failed', operationId, error },
								});
							return of(null);
						}),
					);
				}),
			),
		);
		const changeLifecycle = rxMethod<ChangeCarLifecycleCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						lifecycleOutcome: {
							status: 'pending',
							operationId,
							action: command.action,
						},
					});
					return store.gateway.changeLifecycle(command).pipe(
						tap(() => {
							if (store.carId() !== command.carId) return;
							store.gateway.refresh();
							patchState(store, {
								lifecycleOutcome: {
									status: 'succeeded',
									operationId,
									action: command.action,
								},
							});
						}),
						catchError((error: CarGatewayFailure) => {
							if (store.carId() === command.carId)
								patchState(store, {
									lifecycleOutcome: {
										status: 'failed',
										operationId,
										action: command.action,
										error,
									},
								});
							return of(null);
						}),
					);
				}),
			),
		);
		return {
			selectCar(carId: string): void {
				if (store.carId() === carId) return;
				patchState(store, {
					carId,
					updateOutcome: idleUpdate(),
					lifecycleOutcome: idleLifecycle(),
				});
				store.gateway.selectCar(carId);
			},
			retry(): void {
				store.gateway.refresh();
			},
			clearCarMutationState(): void {
				patchState(store, { updateOutcome: idleUpdate() });
			},
			updateCar(input: GarageCarInput): void {
				const carId = store.carId();
				if (
					!carId ||
					store.updateOutcome().status === 'pending' ||
					store.lifecycleOutcome().status === 'pending'
				)
					return;
				update({ carId, input });
			},
			changeArchiveState(action: 'archive' | 'restore'): void {
				const carId = store.carId();
				if (
					!carId ||
					store.lifecycleOutcome().status === 'pending' ||
					store.updateOutcome().status === 'pending'
				)
					return;
				changeLifecycle({ carId, action });
			},
		};
	}),
);
