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
import { catchError, EMPTY, exhaustMap, Subject, takeUntil, tap } from 'rxjs';
import type { CarReadFailure } from '../car-read-failure';
import {
	type ArchiveDriveSessionCommand,
	type DriveSessionGatewayFailure,
	type DriveSessionOperation,
	type DriveSessionOutcome,
	type SaveDriveSessionCommand,
} from './drive-session.models';
import { DriveSessionGateway } from './drive-session-gateway';
import { resolveTimezone } from './drive-session-time';

type DriveSessionState = {
	carId: string;
	outcome: DriveSessionOutcome;
};

type MutationCommand =
	| {
			readonly operation: 'save-drive-session';
			readonly command: SaveDriveSessionCommand;
			readonly selectionGeneration: number;
	  }
	| {
			readonly operation: 'archive-drive-session';
			readonly command: ArchiveDriveSessionCommand;
			readonly selectionGeneration: number;
	  };

const idleOutcome = (): DriveSessionOutcome => ({
	status: 'idle',
	operation: null,
	operationId: null,
});

const sessionExpired =
	'Your garage session has expired. Sign in again to continue.';

const readFailure = (
	failure: DriveSessionGatewayFailure | null,
): CarReadFailure | null => {
	if (!failure) return null;
	return 'status' in failure && failure.status === 401
		? { message: sessionExpired, retryable: false }
		: {
				message: 'The drive session history could not be loaded.',
				retryable: true,
			};
};

const mutationFailureMessage = (
	failure: DriveSessionGatewayFailure,
	operation: DriveSessionOperation,
): string => {
	if ('status' in failure && failure.status === 401) return sessionExpired;
	if (failure.kind === 'rejected-response') return failure.message;
	if (
		'status' in failure &&
		failure.status === 409 &&
		operation === 'save-drive-session'
	)
		return 'Restore this car before recording a drive session.';
	return operation === 'save-drive-session'
		? 'The drive session could not be saved.'
		: 'The drive session could not be archived.';
};

export const DriveSessionStore = signalStore(
	withState<DriveSessionState>({ carId: '', outcome: idleOutcome() }),
	withProps(() => ({
		gateway: inject(DriveSessionGateway),
		nextOperationId: { value: 0 },
		selectionGeneration: { value: 0 },
		cancelMutations: new Subject<void>(),
	})),
	withComputed((store) => ({
		sessions: computed(() =>
			store.gateway.collection.hasValue()
				? store.gateway.collection.value().sessions
				: [],
		),
		timezone: computed(() => {
			const collectionTimezone = store.gateway.collection.hasValue()
				? store.gateway.collection.value().timezone
				: null;
			const preferenceTimezone = store.gateway.timezone.hasValue()
				? store.gateway.timezone.value().timezone
				: null;
			return resolveTimezone(collectionTimezone, preferenceTimezone);
		}),
		loading: computed(() => store.gateway.collection.isLoading()),
		failure: computed(() => readFailure(store.gateway.collectionFailure())),
		pending: computed(() => store.outcome().status === 'pending'),
		error: computed(() => {
			const outcome = store.outcome();
			return outcome.status === 'failed'
				? mutationFailureMessage(outcome.error, outcome.operation)
				: '';
		}),
		activeCount: computed(() =>
			store.gateway.collection.hasValue()
				? store.gateway.collection
						.value()
						.sessions.filter((session) => !session.deletedAt).length
				: 0,
		),
	})),
	withMethods((store) => {
		const mutate = rxMethod<MutationCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((mutation) => {
					const { operation, command, selectionGeneration } = mutation;
					if (!command.carId || command.carId !== store.carId()) return EMPTY;
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						outcome: { status: 'pending', operation, operationId },
					});
					const request =
						mutation.operation === 'save-drive-session'
							? store.gateway.saveDriveSession(mutation.command)
							: store.gateway.archiveDriveSession(mutation.command);
					return request.pipe(
						takeUntil(store.cancelMutations),
						tap((session) => {
							if (
								store.carId() !== command.carId ||
								store.selectionGeneration.value !== selectionGeneration
							)
								return;
							store.gateway.refresh();
							patchState(store, {
								outcome: {
									status: 'succeeded',
									operation,
									operationId,
									session,
								},
							});
						}),
						catchError((error: DriveSessionGatewayFailure) => {
							if (
								store.carId() === command.carId &&
								store.selectionGeneration.value === selectionGeneration
							)
								patchState(store, {
									outcome: {
										status: 'failed',
										operation,
										operationId,
										error,
									},
								});
							return EMPTY;
						}),
					);
				}),
			),
		);

		return {
			selectCar(carId: string): void {
				if (store.carId() === carId) return;
				store.selectionGeneration.value += 1;
				store.cancelMutations.next();
				patchState(store, { carId, outcome: idleOutcome() });
				store.gateway.selectCar(carId);
			},
			saveDriveSession(command: SaveDriveSessionCommand): void {
				mutate({
					operation: 'save-drive-session',
					command,
					selectionGeneration: store.selectionGeneration.value,
				});
			},
			archiveDriveSession(command: ArchiveDriveSessionCommand): void {
				mutate({
					operation: 'archive-drive-session',
					command,
					selectionGeneration: store.selectionGeneration.value,
				});
			},
			retry(): void {
				store.gateway.refresh();
			},
			refresh(): void {
				store.gateway.refresh();
			},
		};
	}),
);
