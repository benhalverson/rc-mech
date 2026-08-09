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
import type {
	CurrentSetupGatewayFailure,
	CurrentSetupSaveFailure,
	CurrentSetupSaveOutcome,
	CurrentSetupSnapshot,
	SaveCurrentSetupCommand,
} from './current-setup.models';
import {
	changesFromPreviousSetup,
	currentSetupPriorityRows,
	currentSetupRemainingRows,
} from './current-setup.rules';
import { CurrentSetupGateway } from './current-setup-gateway';
import { resolveSetupTimezone } from './setup-change.rules';

export type CurrentSetupFailure = {
	readonly message: string;
	readonly retryable: boolean;
};

type CurrentSetupState = {
	readonly carId: string;
	readonly savedSetup: CurrentSetupSnapshot | null;
	readonly outcome: CurrentSetupSaveOutcome;
};

const idleOutcome = (): CurrentSetupSaveOutcome => ({
	status: 'idle',
	operation: 'save-current-setup',
	operationId: null,
});

const sessionExpired =
	'Your garage session has expired. Sign in again to continue.';

const mutationFailureMessage = (failure: CurrentSetupSaveFailure): string => {
	if (failure.kind === 'invalid-command')
		return 'Name this setup before saving.';
	if (failure.kind === 'stale-current')
		return 'The Current setup changed while you were editing. Review it and try again.';
	if ('status' in failure && failure.status === 401) return sessionExpired;
	if (failure.kind === 'rejected-response') return failure.message;
	if ('status' in failure && failure.status === 409)
		return 'Restore this car before changing its setup.';
	return 'The setup change could not be saved. Check the connection and try again.';
};

export const CurrentSetupStore = signalStore(
	withState<CurrentSetupState>({
		carId: '',
		savedSetup: null,
		outcome: idleOutcome(),
	}),
	withProps(() => ({
		gateway: inject(CurrentSetupGateway),
		nextOperationId: { value: 0 },
		selectionGeneration: { value: 0 },
		cancelMutations: new Subject<void>(),
	})),
	withComputed((store) => {
		const remoteSetups = computed<readonly CurrentSetupSnapshot[]>(() =>
			store.gateway.collection.hasValue()
				? store.gateway.collection
						.value()
						.setups.filter((setup) => setup.carId === store.carId())
				: [],
		);
		const setups = computed(() => {
			const saved = store.savedSetup();
			if (!saved || saved.carId !== store.carId()) return remoteSetups();
			return [
				saved,
				...remoteSetups()
					.filter((setup) => setup.id !== saved.id)
					.map((setup) => ({ ...setup, current: false })),
			];
		});
		const current = computed(() => {
			const saved = store.savedSetup();
			if (saved?.carId === store.carId()) return saved;
			if (!store.gateway.collection.hasValue()) return null;
			const collection = store.gateway.collection.value();
			return (
				remoteSetups().find(
					(setup) => setup.id === collection.currentSetupId,
				) ??
				remoteSetups().find((setup) => setup.current) ??
				null
			);
		});
		return {
			setups,
			current,
			timezone: computed(() =>
				resolveSetupTimezone(
					store.gateway.timezone.hasValue()
						? store.gateway.timezone.value().timezone
						: null,
				),
			),
			timezoneReady: computed(
				() =>
					store.gateway.timezone.hasValue() ||
					!store.gateway.timezone.isLoading(),
			),
			loading: computed(
				() => store.gateway.collection.isLoading() && current() === null,
			),
			failure: computed<CurrentSetupFailure | null>(() => {
				if (current()) return null;
				const failure = store.gateway.failure();
				if (!failure) return null;
				if ('status' in failure && failure.status === 401)
					return { message: sessionExpired, retryable: false };
				if ('status' in failure && failure.status === 404)
					return {
						message: 'The current setup is unavailable for this car.',
						retryable: false,
					};
				return {
					message:
						'The current setup could not be loaded. Check the connection and try again.',
					retryable: true,
				};
			}),
			priorityRows: computed(() => {
				const setup = current();
				return setup ? currentSetupPriorityRows(setup) : [];
			}),
			remainingRows: computed(() => {
				const setup = current();
				return setup ? currentSetupRemainingRows(setup) : [];
			}),
			changes: computed(() => {
				const setup = current();
				return setup ? changesFromPreviousSetup(setup, setups()) : [];
			}),
			pending: computed(() => store.outcome().status === 'pending'),
			saveError: computed(() => {
				const outcome = store.outcome();
				return outcome.status === 'failed'
					? mutationFailureMessage(outcome.error)
					: '';
			}),
		};
	}),
	withMethods((store) => {
		const save = rxMethod<{
			readonly command: SaveCurrentSetupCommand;
			readonly selectionGeneration: number;
		}>((commands$) =>
			commands$.pipe(
				exhaustMap(({ command, selectionGeneration }) => {
					if (!command.carId || command.carId !== store.carId()) return EMPTY;
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						outcome: {
							status: 'pending',
							operation: 'save-current-setup',
							operationId,
						},
					});
					const fail = (error: CurrentSetupSaveFailure) => {
						patchState(store, {
							outcome: {
								status: 'failed',
								operation: 'save-current-setup',
								operationId,
								error,
							},
						});
						return EMPTY;
					};
					if (!command.sourceSetupId || !command.draft.name.trim())
						return fail({ kind: 'invalid-command' });
					if (
						!command.sourceUpdatedAt ||
						store.current()?.id !== command.sourceSetupId ||
						store.current()?.updatedAt !== command.sourceUpdatedAt
					)
						return fail({ kind: 'stale-current' });
					return store.gateway.saveCurrentSetup(command).pipe(
						takeUntil(store.cancelMutations),
						tap((setup) => {
							if (
								store.carId() !== command.carId ||
								store.selectionGeneration.value !== selectionGeneration
							)
								return;
							patchState(store, {
								savedSetup: setup,
								outcome: {
									status: 'succeeded',
									operation: 'save-current-setup',
									operationId,
									setup,
								},
							});
							store.gateway.refresh();
						}),
						catchError((error: CurrentSetupGatewayFailure) => {
							if (
								store.carId() === command.carId &&
								store.selectionGeneration.value === selectionGeneration
							)
								fail(error);
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
				patchState(store, {
					carId,
					savedSetup: null,
					outcome: idleOutcome(),
				});
			},
			saveCurrentSetup(command: SaveCurrentSetupCommand): void {
				save({
					command,
					selectionGeneration: store.selectionGeneration.value,
				});
			},
			clearSaveOutcome(): void {
				if (store.outcome().status !== 'pending')
					patchState(store, { outcome: idleOutcome() });
			},
			retry(): void {
				store.gateway.refresh();
			},
		};
	}),
);
