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
import { catchError, EMPTY, exhaustMap, Subject, takeUntil, tap } from 'rxjs';
import { CarWorkspaceStore } from '../../garage/car-sync/car-workspace-store';
import type { CarReadFailure } from '../car-read-failure';
import type { DriveSyncCommand } from '../drive-sync/drive-sync.models';
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
	localCommand: DriveSyncCommand | null;
	localOperationId: string;
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

/**
 * Route workflow for viewing and editing outings. Projects the shared Car
 * workspace when prepared and submits durable Drive intents, retaining the online
 * path otherwise. UI outcomes belong here; cross-route replay and usage identity
 * belong to CarWorkspaceStore and its persisted operations.
 */
export const DriveSessionStore = signalStore(
	withState<DriveSessionState>({
		carId: '',
		outcome: idleOutcome(),
		localCommand: null,
		localOperationId: '',
	}),
	withProps(() => ({
		gateway: inject(DriveSessionGateway),
		workspace: inject(CarWorkspaceStore),
		nextOperationId: { value: 0 },
		selectionGeneration: { value: 0 },
		cancelMutations: new Subject<void>(),
	})),
	withComputed((store) => ({
		sessions: computed(
			() =>
				store.workspace
					.driveCollections()
					.find((collection) => collection.carId === store.carId())?.sessions ??
				(store.gateway.collection.hasValue()
					? store.gateway.collection.value().sessions
					: []),
		),
		timezone: computed(() => {
			const collectionTimezone =
				store.workspace
					.driveCollections()
					.find((collection) => collection.carId === store.carId())?.timezone ??
				(store.gateway.collection.hasValue()
					? store.gateway.collection.value().timezone
					: null);
			const preferenceTimezone = store.gateway.timezone.hasValue()
				? store.gateway.timezone.value().timezone
				: null;
			return resolveTimezone(collectionTimezone, preferenceTimezone);
		}),
		loading: computed(
			() => !store.workspace.opened() && store.gateway.collection.isLoading(),
		),
		failure: computed(() =>
			store.workspace.opened()
				? null
				: readFailure(store.gateway.collectionFailure()),
		),
		syncOperations: computed(() =>
			store.workspace
				.driveOperations()
				.filter((operation) => operation.carId === store.carId()),
		),
		localPending: computed(() =>
			store.workspace
				.driveOperations()
				.some(
					(operation) => operation.operationId === store.localOperationId(),
				),
		),
		pending: computed(() => store.outcome().status === 'pending'),
		error: computed(() => {
			const outcome = store.outcome();
			return outcome.status === 'failed'
				? mutationFailureMessage(outcome.error, outcome.operation)
				: '';
		}),
	})),
	withComputed((store) => ({
		activeCount: computed(
			() => store.sessions().filter((session) => !session.deletedAt).length,
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

		const commitLocal = (
			command: DriveSyncCommand,
			operation: DriveSessionOperation,
		): void => {
			if (!command.carId || command.carId !== store.carId() || store.pending())
				return;
			patchState(store, {
				localCommand: command,
				localOperationId: '',
				outcome: {
					status: 'pending',
					operation,
					operationId: ++store.nextOperationId.value,
				},
			});
			store.workspace.commitDrive(command);
		};

		return {
			selectCar(carId: string): void {
				if (store.carId() === carId) return;
				store.selectionGeneration.value += 1;
				store.cancelMutations.next();
				patchState(store, {
					carId,
					outcome: idleOutcome(),
					localCommand: null,
					localOperationId: '',
				});
				store.gateway.selectCar(carId);
			},
			saveDriveSession(command: SaveDriveSessionCommand): void {
				if (store.workspace.durableSetupMutationsAvailable()) {
					commitLocal(
						{
							action: 'save',
							carId: command.carId,
							sessionId: command.sessionId,
							input: command.draft,
						},
						'save-drive-session',
					);
					return;
				}
				mutate({
					operation: 'save-drive-session',
					command,
					selectionGeneration: store.selectionGeneration.value,
				});
			},
			archiveDriveSession(command: ArchiveDriveSessionCommand): void {
				if (store.workspace.durableSetupMutationsAvailable()) {
					const session = store
						.sessions()
						.find((value) => value.id === command.sessionId);
					if (!session) return;
					commitLocal(
						{
							action: 'archive',
							carId: command.carId,
							sessionId: command.sessionId,
							input: {
								startedAt: session.startedAt,
								durationMinutes: session.durationMinutes,
								conditions: session.conditions ?? '',
								notes: session.notes ?? '',
							},
						},
						'archive-drive-session',
					);
					return;
				}
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

	withHooks({
		onInit(store) {
			effect(() => {
				const result = store.workspace.driveMutationOutcome();
				const pending = store.outcome();
				if (
					pending.status !== 'pending' ||
					result.status === 'idle' ||
					result.command !== store.localCommand()
				)
					return;
				if (result.status === 'succeeded') {
					const session = result.collection.sessions.find(
						(value) =>
							value.id ===
							(result.command.sessionId ??
								result.collection.sessions.at(-1)?.id),
					);
					if (!session) return;
					patchState(store, {
						localOperationId: result.operationId,
						outcome: {
							status: 'succeeded',
							operation: pending.operation,
							operationId: pending.operationId,
							session,
						},
					});
				} else if (result.status === 'failed')
					patchState(store, {
						outcome: {
							status: 'failed',
							operation: pending.operation,
							operationId: pending.operationId,
							error: {
								kind: 'rejected-response',
								status: 0,
								message: result.error.message,
							},
						},
					});
			});
		},
	}),
);
