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
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => ({
		cars: computed(() =>
			store.gateway.collection.hasValue()
				? store.gateway.collection.value().cars
				: [],
		),
		collectionLoading: computed(() => store.gateway.collection.isLoading()),
		collectionError: computed(() =>
			collectionErrorMessage(store.gateway.collectionFailure()),
		),
		carAction: computed(() =>
			store.createOutcome().status === 'pending' ? ('create' as const) : null,
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
				create(command);
			},
		};
	}),
);
