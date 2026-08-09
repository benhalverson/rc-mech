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
	  }
	| { readonly kind: 'copy'; readonly setup: SetupSnapshot }
	| { readonly kind: 'select-current'; readonly setup: SetupSnapshot };

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
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => ({
		setups: computed(
			() =>
				store.localSetups() ??
				(store.gateway.collection.hasValue()
					? store.gateway.collection.value()
					: []),
		),
		loading: computed(() => store.gateway.collection.isLoading()),
		failure: computed(() =>
			carReadFailure(
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
	})),
	withHooks({
		onInit(store) {
			effect(() => {
				if (
					store.gateway.collection.hasValue() &&
					!store.gateway.collection.isLoading()
				) {
					store.gateway.collection.value();
					patchState(store, { localSetups: null });
				}
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
			},
			mutate(command: SetupWorkflowCommand): void {
				if (store.carId() && store.outcome().status !== 'pending')
					mutate(command);
			},
		};
	}),
);
