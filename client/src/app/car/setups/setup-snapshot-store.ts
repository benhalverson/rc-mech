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
import {
	catchError,
	exhaustMap,
	map,
	type Observable,
	of,
	switchMap,
	tap,
} from 'rxjs';
import {
	CarWorkspaceStore,
	type SetupWorkspaceMutationFailure,
} from '../../garage/car-sync/car-workspace-store';
import { carReadFailure } from '../car-read-failure';
import {
	type SetupGatewayFailure,
	type SetupImportReview,
	type SetupSnapshot,
	type SetupSnapshotDraft,
	SetupSnapshotGateway,
	SoDialedImportGateway,
	type SoDialedImportPreview,
} from './setup-snapshot';
import type { SetupSyncCommand } from './setup-sync.models';

export type SetupWorkflowCommand =
	| { readonly kind: 'preview'; readonly carId: string; readonly url: string }
	| { readonly kind: 'cancel-import'; readonly draftId: string }
	| {
			readonly kind: 'save';
			readonly sourceCarId: string;
			readonly targetCarId: string;
			readonly mode: 'add' | 'edit';
			readonly setupId: string | null;
			readonly snapshot: SetupSnapshotDraft;
			readonly importDraft: null | {
				readonly draftId: string;
				readonly review: SetupImportReview;
				readonly name: string;
			};
	  }
	| { readonly kind: 'copy'; readonly carId: string; readonly setupId: string }
	| {
			readonly kind: 'select-current';
			readonly carId: string;
			readonly setupId: string;
	  };

export type SetupWorkflowResult =
	| { readonly kind: 'preview'; readonly preview: SoDialedImportPreview }
	| { readonly kind: 'cancel-import' }
	| {
			readonly kind: 'save';
			readonly setup: SetupSnapshot;
			readonly targetCarId: string;
			readonly retainedLocally?: boolean;
	  }
	| {
			readonly kind: 'copy';
			readonly setup: SetupSnapshot;
			readonly retainedLocally?: boolean;
	  }
	| {
			readonly kind: 'select-current';
			readonly setup: SetupSnapshot;
			readonly retainedLocally?: boolean;
	  };

export type SetupWorkflowOutcome =
	| { readonly status: 'idle'; readonly operationId: null }
	| {
			readonly status: 'pending';
			readonly operationId: number;
			readonly command: SetupWorkflowCommand;
	  }
	| {
			readonly status: 'succeeded';
			readonly operationId: number;
			readonly command: SetupWorkflowCommand;
			readonly result: SetupWorkflowResult;
	  }
	| {
			readonly status: 'failed';
			readonly operationId: number;
			readonly command: SetupWorkflowCommand;
			readonly error: SetupGatewayFailure;
	  };

const idleOutcome = (): SetupWorkflowOutcome => ({
	status: 'idle',
	operationId: null,
});

const setupSyncCommand = (
	command: SetupWorkflowCommand,
): SetupSyncCommand | null => {
	if (command.kind === 'copy')
		return { type: 'copy', carId: command.carId, setupId: command.setupId };
	if (command.kind === 'select-current')
		return {
			type: 'select-current',
			carId: command.carId,
			setupId: command.setupId,
		};
	if (command.kind !== 'save' || command.importDraft) return null;
	return command.mode === 'edit' && command.setupId
		? {
				type: 'correct',
				carId: command.sourceCarId,
				setupId: command.setupId,
				draft: command.snapshot,
			}
		: {
				type: 'create',
				carId: command.targetCarId,
				draft: command.snapshot,
			};
};

const setupWorkflowFailure = (
	failure: SetupWorkspaceMutationFailure,
): SetupGatewayFailure => {
	if (failure.kind === 'local') return failure;
	if (failure.kind === 'needs-attention')
		return { kind: 'needs-attention', message: failure.feedback.message };
	if (failure.kind === 'conflict')
		return { kind: 'conflict', message: failure.feedback.message };
	return failure;
};

const replaceSetup = (
	setups: readonly SetupSnapshot[],
	updated: SetupSnapshot,
): SetupSnapshot[] =>
	setups.some((setup) => setup.id === updated.id)
		? setups.map((setup) => (setup.id === updated.id ? updated : setup))
		: [updated, ...setups];

export const setupCollectionAfterResult = (
	setups: readonly SetupSnapshot[],
	result: SetupWorkflowResult,
	carId: string,
): SetupSnapshot[] | null => {
	if (result.kind === 'save')
		return result.targetCarId === carId
			? replaceSetup(setups, result.setup)
			: null;
	if (result.kind === 'copy') return replaceSetup(setups, result.setup);
	if (result.kind !== 'select-current') return null;
	return replaceSetup(setups, result.setup).map((setup) => ({
		...setup,
		current: setup.id === result.setup.id,
	}));
};

const mutationRequest = (
	gateway: SetupSnapshotGateway,
	importer: SoDialedImportGateway,
	command: SetupWorkflowCommand,
): Observable<SetupWorkflowResult> => {
	switch (command.kind) {
		case 'preview':
			return importer
				.preview(command.url, command.carId)
				.pipe(map((preview) => ({ kind: 'preview', preview }) as const));
		case 'cancel-import':
			return importer
				.cancel(command.draftId)
				.pipe(map(() => ({ kind: 'cancel-import' }) as const));
		case 'save': {
			const importDraft = command.importDraft;
			const request = importDraft
				? importer
						.update(importDraft.draftId, importDraft.review)
						.pipe(
							switchMap(() =>
								importer.accept(
									importDraft.draftId,
									command.targetCarId,
									importDraft.name,
								),
							),
						)
				: command.mode === 'edit' && command.setupId
					? gateway.update(
							command.sourceCarId,
							command.setupId,
							command.snapshot,
						)
					: gateway.create(command.targetCarId, command.snapshot);
			return request.pipe(
				map(
					(setup) =>
						({
							kind: 'save',
							setup,
							targetCarId: command.targetCarId,
						}) as const,
				),
			);
		}
		case 'copy':
			return gateway
				.copy(command.carId, command.setupId)
				.pipe(map((setup) => ({ kind: 'copy', setup }) as const));
		case 'select-current':
			return gateway
				.selectCurrent(command.carId, command.setupId)
				.pipe(map((setup) => ({ kind: 'select-current', setup }) as const));
	}
};

export const SetupSnapshotStore = signalStore(
	withState<{
		carId: string;
		localSetups: SetupSnapshot[] | null;
		outcome: SetupWorkflowOutcome;
	}>({
		carId: '',
		localSetups: null,
		outcome: idleOutcome(),
	}),
	withProps(() => ({
		gateway: inject(SetupSnapshotGateway),
		importer: inject(SoDialedImportGateway),
		workspace: inject(CarWorkspaceStore),
		nextOperationId: { value: 0 },
		activeWorkspace: {
			requestId: null as number | null,
			operationId: 0,
			workflowCommand: null as SetupWorkflowCommand | null,
			workspaceCommand: null as SetupSyncCommand | null,
		},
	})),
	withComputed((store) => {
		const workspaceCollection = computed(() =>
			store.workspace
				.setupCollections()
				.find((collection) => collection.carId === store.carId()),
		);
		return {
			workspaceCollection,
			setups: computed(
				() =>
					workspaceCollection()?.setups ??
					store.localSetups() ??
					(store.gateway.collection.hasValue()
						? store.gateway.collection.value()
						: []),
			),
			loading: computed(
				() => store.gateway.collection.isLoading() && !workspaceCollection(),
			),
			failure: computed(() =>
				workspaceCollection()
					? null
					: carReadFailure(
							store.gateway.failure(),
							'Setup history could not be loaded. Check the connection and try again.',
						),
			),
			action: computed(() => {
				const outcome = store.outcome();
				if (outcome.status !== 'pending') return null;
				return outcome.command.kind === 'select-current'
					? ('current' as const)
					: outcome.command.kind === 'cancel-import'
						? null
						: outcome.command.kind;
			}),
			syncMark: computed(() => store.workspace.setupMark(store.carId())),
		};
	}),
	withHooks({
		onInit(store) {
			effect(() => {
				if (
					store.gateway.collection.hasValue() &&
					!store.gateway.collection.isLoading()
				) {
					store.gateway.collection.value();
					const synchronized = store.gateway.synchronizedCollection();
					if (synchronized)
						store.workspace.observeServerSetupCollection(synchronized);
					patchState(store, { localSetups: null });
				}
			});
			effect(() => {
				const outcome = store.workspace.setupMutationOutcome();
				const active = store.activeWorkspace;
				if (
					active.requestId === null ||
					outcome.status === 'idle' ||
					outcome.status === 'pending' ||
					outcome.requestId !== active.requestId ||
					outcome.command !== active.workspaceCommand ||
					!active.workflowCommand
				)
					return;
				const command = active.workflowCommand;
				const operationId = active.operationId;
				active.requestId = null;
				active.workflowCommand = null;
				active.workspaceCommand = null;
				if (outcome.status === 'failed') {
					patchState(store, {
						outcome: {
							status: 'failed',
							operationId,
							command,
							error: setupWorkflowFailure(outcome.error),
						},
					});
					return;
				}
				const result: SetupWorkflowResult =
					command.kind === 'save'
						? {
								kind: 'save',
								setup: outcome.setup,
								targetCarId: command.targetCarId,
								retainedLocally: outcome.retainedLocally,
							}
						: command.kind === 'copy'
							? {
									kind: 'copy',
									setup: outcome.setup,
									retainedLocally: outcome.retainedLocally,
								}
							: {
									kind: 'select-current',
									setup: outcome.setup,
									retainedLocally: outcome.retainedLocally,
								};
				patchState(store, {
					outcome: {
						status: 'succeeded',
						operationId,
						command,
						result,
					},
				});
			});
		},
	}),
	withMethods((store) => {
		const mutate = rxMethod<SetupWorkflowCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const carId = store.carId();
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						outcome: { status: 'pending', operationId, command },
					});
					return mutationRequest(store.gateway, store.importer, command).pipe(
						tap((result) => {
							if (store.carId() !== carId) return;
							const localSetups = setupCollectionAfterResult(
								store.setups(),
								result,
								carId,
							);
							if (localSetups) {
								patchState(store, { localSetups });
								store.gateway.refresh();
							}
							patchState(store, {
								outcome: { status: 'succeeded', operationId, command, result },
							});
						}),
						catchError((error: SetupGatewayFailure) => {
							if (store.carId() === carId)
								patchState(store, {
									outcome: { status: 'failed', operationId, command, error },
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
				store.activeWorkspace.requestId = null;
				store.activeWorkspace.workflowCommand = null;
				store.activeWorkspace.workspaceCommand = null;
				patchState(store, {
					carId,
					localSetups: null,
					outcome: idleOutcome(),
				});
				store.gateway.selectCar(carId);
			},
			retry(): void {
				store.gateway.refresh();
			},
			refresh(): void {
				store.gateway.refresh();
			},
			clearOutcome(): void {
				patchState(store, { outcome: idleOutcome() });
				store.workspace.clearSetupMutationState();
			},
			mutate(command: SetupWorkflowCommand): void {
				if (!store.carId() || store.outcome().status === 'pending') return;
				const workspaceCommand = setupSyncCommand(command);
				if (
					workspaceCommand &&
					store.workspace.durableSetupMutationsAvailable()
				) {
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						outcome: { status: 'pending', operationId, command },
					});
					store.workspace.clearSetupMutationState();
					store.workspace.commitSetup(workspaceCommand);
					const workspaceOutcome = store.workspace.setupMutationOutcome();
					if (
						workspaceOutcome.status === 'pending' &&
						workspaceOutcome.command === workspaceCommand
					) {
						store.activeWorkspace.requestId = workspaceOutcome.requestId;
						store.activeWorkspace.operationId = operationId;
						store.activeWorkspace.workflowCommand = command;
						store.activeWorkspace.workspaceCommand = workspaceCommand;
					} else {
						patchState(store, {
							outcome: {
								status: 'failed',
								operationId,
								command,
								error: {
									kind: 'local',
									message:
										'The setup change could not be saved on this device.',
								},
							},
						});
					}
					return;
				}
				if (!store.workspace.externalRequestsAvailable()) {
					patchState(store, {
						outcome: {
							status: 'failed',
							operationId: ++store.nextOperationId.value,
							command,
							error: { kind: 'unavailable' },
						},
					});
					return;
				}
				mutate(command);
			},
		};
	}),
);
