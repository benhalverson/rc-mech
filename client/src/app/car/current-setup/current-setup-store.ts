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
import {
	CarWorkspaceStore,
	type SetupWorkspaceMutationFailure,
} from '../../garage/car-sync/car-workspace-store';
import type {
	SetupSnapshot,
	SetupSnapshotDraft,
} from '../setups/setup-snapshot';
import type {
	SetupSyncCollection,
	SetupSyncCommand,
} from '../setups/setup-sync.models';
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
	if (failure.kind === 'local') return failure.message;
	if (failure.kind === 'needs-attention' || failure.kind === 'conflict')
		return failure.message;
	if ('status' in failure && failure.status === 401) return sessionExpired;
	if (failure.kind === 'rejected-response') return failure.message;
	if ('status' in failure && failure.status === 409)
		return 'Restore this car before changing its setup.';
	return 'The setup change could not be saved. Check the connection and try again.';
};

const sectionValues = (
	section: Readonly<Record<string, unknown>>,
): Record<string, string | null> =>
	Object.fromEntries(
		Object.entries(section).map(([key, value]) => [
			key,
			value === null || typeof value === 'string' ? value : String(value),
		]),
	);

const asSetupSnapshot = (setup: CurrentSetupSnapshot): SetupSnapshot => ({
	...setup,
	sections: {
		vehicle: sectionValues(setup.sections.vehicle),
		drivetrain: sectionValues(setup.sections.drivetrain),
		electronics: sectionValues(setup.sections.electronics),
		tires: sectionValues(setup.sections.tires),
		shocks: sectionValues(setup.sections.shocks),
		frontSuspension: sectionValues(setup.sections.frontSuspension),
		rearSuspension: sectionValues(setup.sections.rearSuspension),
		notes: sectionValues(setup.sections.notes),
	},
});

const asCurrentSetupSnapshot = (
	setup: SetupSnapshot,
): CurrentSetupSnapshot => ({
	...setup,
	current: setup.current === true,
	context: setup.context ?? {},
	copiedFromSetupId: setup.copiedFromSetupId ?? null,
});

const setupDraft = (command: SaveCurrentSetupCommand): SetupSnapshotDraft => {
	const { sections, recordedAt, ...context } = command.draft;
	const notes = sections.notes['setupNotes'];
	return {
		...context,
		status: 'active',
		setupDate: recordedAt,
		vehicle: sections.vehicle,
		drivetrain: sections.drivetrain,
		electronics: sections.electronics,
		tires: sections.tires,
		shocks: sections.shocks,
		frontSuspension: sections.frontSuspension,
		rearSuspension: sections.rearSuspension,
		notes: typeof notes === 'string' ? notes : null,
	};
};

const workspaceFailure = (
	failure: SetupWorkspaceMutationFailure,
): CurrentSetupSaveFailure => {
	if (failure.kind === 'needs-attention')
		return { kind: 'needs-attention', message: failure.feedback.message };
	if (failure.kind === 'conflict')
		return { kind: 'conflict', message: failure.feedback.message };
	return failure;
};

export const CurrentSetupStore = signalStore(
	withState<CurrentSetupState>({
		carId: '',
		savedSetup: null,
		outcome: idleOutcome(),
	}),
	withProps(() => ({
		gateway: inject(CurrentSetupGateway),
		workspace: inject(CarWorkspaceStore),
		nextOperationId: { value: 0 },
		selectionGeneration: { value: 0 },
		cancelMutations: new Subject<void>(),
		activeWorkspace: {
			requestId: null as number | null,
			operationId: 0,
			selectionGeneration: 0,
			command: null as SetupSyncCommand | null,
		},
	})),
	withComputed((store) => {
		const workspaceCollection = computed(() =>
			store.workspace
				.setupCollections()
				.find((collection) => collection.carId === store.carId()),
		);
		const remoteCollection = computed<SetupSyncCollection | null>(() => {
			if (!store.gateway.collection.hasValue() || !store.carId()) return null;
			const collection = store.gateway.collection.value();
			return {
				carId: store.carId(),
				currentSetupId: collection.currentSetupId,
				currentSetupVersion: collection.currentSetupVersion ?? 0,
				setups: collection.setups
					.filter((setup) => setup.carId === store.carId())
					.map(asSetupSnapshot),
			};
		});
		const collection = computed(
			() => workspaceCollection() ?? remoteCollection(),
		);
		const remoteSetups = computed<readonly CurrentSetupSnapshot[]>(() =>
			(collection()?.setups ?? []).map(asCurrentSetupSnapshot),
		);
		const setups = computed<readonly CurrentSetupSnapshot[]>(() => {
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
			const selected = collection()?.currentSetupId;
			return (
				setups().find((setup) => setup.id === selected) ??
				setups().find((setup) => setup.current) ??
				null
			);
		});
		return {
			workspaceCollection,
			remoteCollection,
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
				() =>
					store.gateway.collection.isLoading() &&
					workspaceCollection() === undefined &&
					current() === null,
			),
			failure: computed<CurrentSetupFailure | null>(() => {
				if (current() || workspaceCollection()) return null;
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
			syncMark: computed(() => store.workspace.setupMark(store.carId())),
		};
	}),
	withHooks({
		onInit(store) {
			effect(() => {
				const collection = store.remoteCollection();
				if (collection && !store.gateway.collection.isLoading())
					store.workspace.observeServerSetupCollection(collection);
			});
			effect(() => {
				const outcome = store.workspace.setupMutationOutcome();
				const active = store.activeWorkspace;
				if (
					active.requestId === null ||
					outcome.status === 'idle' ||
					outcome.status === 'pending' ||
					outcome.requestId !== active.requestId ||
					outcome.command !== active.command ||
					active.selectionGeneration !== store.selectionGeneration.value
				)
					return;
				const operationId = active.operationId;
				active.requestId = null;
				active.command = null;
				patchState(store, {
					outcome:
						outcome.status === 'failed'
							? {
									status: 'failed',
									operation: 'save-current-setup',
									operationId,
									error: workspaceFailure(outcome.error),
								}
							: {
									status: 'succeeded',
									operation: 'save-current-setup',
									operationId,
									setup: asCurrentSetupSnapshot(outcome.setup),
									retainedLocally: outcome.retainedLocally,
								},
				});
			});
		},
	}),
	withMethods((store) => {
		const saveRemotely = rxMethod<{
			readonly command: SaveCurrentSetupCommand;
			readonly operationId: number;
			readonly selectionGeneration: number;
		}>((commands$) =>
			commands$.pipe(
				exhaustMap(({ command, operationId, selectionGeneration }) =>
					store.gateway.saveCurrentSetup(command).pipe(
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
									retainedLocally: false,
								},
							});
							store.gateway.refresh();
						}),
						catchError((error: CurrentSetupGatewayFailure) => {
							if (
								store.carId() === command.carId &&
								store.selectionGeneration.value === selectionGeneration
							)
								patchState(store, {
									outcome: {
										status: 'failed',
										operation: 'save-current-setup',
										operationId,
										error,
									},
								});
							return EMPTY;
						}),
					),
				),
			),
		);

		return {
			selectCar(carId: string): void {
				if (store.carId() === carId) return;
				store.selectionGeneration.value += 1;
				store.cancelMutations.next();
				store.activeWorkspace.requestId = null;
				store.activeWorkspace.command = null;
				patchState(store, {
					carId,
					savedSetup: null,
					outcome: idleOutcome(),
				});
			},
			saveCurrentSetup(command: SaveCurrentSetupCommand): void {
				if (
					!command.carId ||
					command.carId !== store.carId() ||
					store.outcome().status === 'pending'
				)
					return;
				const operationId = ++store.nextOperationId.value;
				const fail = (error: CurrentSetupSaveFailure): void =>
					patchState(store, {
						outcome: {
							status: 'failed',
							operation: 'save-current-setup',
							operationId,
							error,
						},
					});
				patchState(store, {
					outcome: {
						status: 'pending',
						operation: 'save-current-setup',
						operationId,
					},
				});
				if (!command.sourceSetupId || !command.draft.name.trim()) {
					fail({ kind: 'invalid-command' });
					return;
				}
				if (
					!command.sourceUpdatedAt ||
					store.current()?.id !== command.sourceSetupId ||
					store.current()?.updatedAt !== command.sourceUpdatedAt
				) {
					fail({ kind: 'stale-current' });
					return;
				}
				if (!store.workspace.durableSetupMutationsAvailable()) {
					if (!store.workspace.externalRequestsAvailable()) {
						fail({ kind: 'unavailable' });
						return;
					}
					saveRemotely({
						command,
						operationId,
						selectionGeneration: store.selectionGeneration.value,
					});
					return;
				}
				const workspaceCommand: SetupSyncCommand = {
					type: 'change',
					carId: command.carId,
					setupId: command.sourceSetupId,
					draft: setupDraft(command),
				};
				store.workspace.clearSetupMutationState();
				store.workspace.commitSetup(workspaceCommand);
				const outcome = store.workspace.setupMutationOutcome();
				if (
					outcome.status !== 'pending' ||
					outcome.command !== workspaceCommand
				) {
					fail({
						kind: 'local',
						message: 'The setup change could not be saved on this device.',
					});
					return;
				}
				store.activeWorkspace.requestId = outcome.requestId;
				store.activeWorkspace.operationId = operationId;
				store.activeWorkspace.selectionGeneration =
					store.selectionGeneration.value;
				store.activeWorkspace.command = workspaceCommand;
			},
			clearSaveOutcome(): void {
				if (store.outcome().status !== 'pending') {
					patchState(store, { outcome: idleOutcome() });
					store.workspace.clearSetupMutationState();
				}
			},
			retry(): void {
				store.gateway.refresh();
			},
		};
	}),
);
