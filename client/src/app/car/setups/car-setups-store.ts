import { computed, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import type { CarWorkspaceMutationFailure } from '../../garage/car-sync/car-workspace-store';
import { CarWorkspaceStore } from '../../garage/car-sync/car-workspace-store';
import type {
	GarageCarInput,
	GarageCreateOutcome,
} from '../../garage/garage.models';
import { GarageGateway } from '../../garage/garage-gateway';
import { carReadFailure } from '../car-read-failure';

const idleOutcome = (): GarageCreateOutcome => ({
	status: 'idle',
	operationId: null,
});

const createError = (failure: CarWorkspaceMutationFailure): string =>
	failure.kind === 'http' && failure.status === 401
		? 'Your garage session has expired. Sign in again to continue.'
		: 'The new car could not be created from this reviewed import.';

const legacyFailure = (
	failure: CarWorkspaceMutationFailure,
): Extract<GarageCreateOutcome, { status: 'failed' }>['error'] =>
	failure.kind === 'http' ||
	failure.kind === 'unavailable' ||
	failure.kind === 'invalid-response'
		? failure
		: { kind: 'invalid-response' };

export type CreateSetupImportCarCommand = {
	readonly sourceCarId: string;
	readonly input: GarageCarInput;
};

export const CarSetupsStore = signalStore(
	withState<{ sourceCarId: string; activeRequestId: number | null }>({
		sourceCarId: '',
		activeRequestId: null,
	}),
	withProps(() => ({
		gateway: inject(GarageGateway),
		workspace: inject(CarWorkspaceStore),
	})),
	withComputed((store) => {
		const createOutcome = computed<GarageCreateOutcome>(() => {
			const requestId = store.activeRequestId();
			const outcome = store.workspace.mutationOutcome();
			if (
				requestId === null ||
				outcome.status === 'idle' ||
				outcome.requestId !== requestId ||
				outcome.command.type !== 'create'
			)
				return idleOutcome();
			if (outcome.status === 'pending')
				return { status: 'pending', operationId: requestId };
			if (outcome.status === 'succeeded')
				return {
					status: 'succeeded',
					operationId: requestId,
					car: outcome.car,
				};
			return {
				status: 'failed',
				operationId: requestId,
				error: legacyFailure(outcome.error),
			};
		});
		const workspaceAvailable = computed(() => store.workspace.opened());
		return {
			createOutcome,
			availableCars: computed(() => {
				const cars = new Map(
					(store.gateway.collection.hasValue()
						? store.gateway.collection.value().cars
						: []
					).map((car) => [car.id, car]),
				);
				for (const car of store.workspace.cars()) cars.set(car.id, car);
				return [...cars.values()];
			}),
			loading: computed(
				() => !workspaceAvailable() && store.gateway.collection.isLoading(),
			),
			failure: computed(() => {
				const failure = store.gateway.collectionFailure();
				return workspaceAvailable() &&
					!(failure?.kind === 'http' && failure.status === 401)
					? null
					: carReadFailure(
							failure,
							'The garage list needed for setup imports could not be loaded.',
						);
			}),
			createAction: computed(() => createOutcome().status === 'pending'),
			createError: computed(() => {
				const requestId = store.activeRequestId();
				const outcome = store.workspace.mutationOutcome();
				return requestId !== null &&
					outcome.status === 'failed' &&
					outcome.requestId === requestId &&
					outcome.command.type === 'create'
					? createError(outcome.error)
					: '';
			}),
		};
	}),
	withMethods((store) => ({
		selectSourceCar(sourceCarId: string): void {
			if (store.sourceCarId() !== sourceCarId)
				patchState(store, { sourceCarId, activeRequestId: null });
		},
		retry(): void {
			store.gateway.refresh();
		},
		refresh(): void {
			store.gateway.refresh();
		},
		clearCreateOutcome(): void {
			patchState(store, { activeRequestId: null });
			store.workspace.clearMutationState();
		},
		createCar(command: CreateSetupImportCarCommand): void {
			if (
				store.sourceCarId() !== command.sourceCarId ||
				!store.workspace.mutationsAvailable() ||
				store.workspace.mutationOutcome().status === 'pending'
			)
				return;
			store.workspace.clearMutationState();
			const workspaceCommand = {
				type: 'create' as const,
				input: command.input,
			};
			store.workspace.commit(workspaceCommand);
			const outcome = store.workspace.mutationOutcome();
			if (
				outcome.status === 'pending' &&
				outcome.command === workspaceCommand
			) {
				patchState(store, { activeRequestId: outcome.requestId });
			}
		},
	})),
);
