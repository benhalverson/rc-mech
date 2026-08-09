import { computed, inject } from '@angular/core';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { catchError, exhaustMap, of, tap } from 'rxjs';
import { GarageGateway } from '../../garage/garage-gateway';
import type {
	GarageCarInput,
	GarageCreateOutcome,
	GarageGatewayFailure,
} from '../../garage/garage.models';
import { carReadFailure } from '../car-read-failure';

const idleOutcome = (): GarageCreateOutcome => ({
	status: 'idle',
	operationId: null,
});

const createError = (failure: GarageGatewayFailure): string =>
	failure.kind === 'http' && failure.status === 401
		? 'Your garage session has expired. Sign in again to continue.'
		: 'The new car could not be created from this reviewed import.';

export type CreateSetupImportCarCommand = {
	readonly sourceCarId: string;
	readonly input: GarageCarInput;
};

export const CarSetupsStore = signalStore(
	withState<{ sourceCarId: string; createOutcome: GarageCreateOutcome }>({
		sourceCarId: '',
		createOutcome: idleOutcome(),
	}),
	withProps(() => ({
		gateway: inject(GarageGateway),
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => ({
		availableCars: computed(() =>
			store.gateway.collection.hasValue()
				? store.gateway.collection.value().cars
				: [],
		),
		loading: computed(() => store.gateway.collection.isLoading()),
		failure: computed(() =>
			carReadFailure(
				store.gateway.collectionFailure(),
				'The garage list needed for setup imports could not be loaded.',
			),
		),
		createAction: computed(() => store.createOutcome().status === 'pending'),
		createError: computed(() => {
			const outcome = store.createOutcome();
			return outcome.status === 'failed' ? createError(outcome.error) : '';
		}),
	})),
	withMethods((store) => {
		const create = rxMethod<CreateSetupImportCarCommand>((commands$) =>
			commands$.pipe(
				exhaustMap(({ sourceCarId, input }) => {
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						createOutcome: { status: 'pending', operationId },
					});
					return store.gateway.createCar(input).pipe(
						tap((car) => {
							if (store.sourceCarId() !== sourceCarId) return;
							store.gateway.refresh();
							patchState(store, {
								createOutcome: { status: 'succeeded', operationId, car },
							});
						}),
						catchError((error: GarageGatewayFailure) => {
							if (store.sourceCarId() !== sourceCarId) return of(null);
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
			selectSourceCar(sourceCarId: string): void {
				if (store.sourceCarId() !== sourceCarId)
					patchState(store, { sourceCarId, createOutcome: idleOutcome() });
			},
			retry(): void {
				store.gateway.refresh();
			},
			refresh(): void {
				store.gateway.refresh();
			},
			clearCreateOutcome(): void {
				patchState(store, { createOutcome: idleOutcome() });
			},
			createCar(command: CreateSetupImportCarCommand): void {
				if (
					store.sourceCarId() === command.sourceCarId &&
					store.createOutcome().status !== 'pending'
				)
					create(command);
			},
		};
	}),
);
