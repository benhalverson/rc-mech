import { computed, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { catchError, type Observable, of, tap } from 'rxjs';
import type {
	CreateTrackLayoutCommand,
	CreateTrackMapDraftCommand,
	RenameTrackLayoutCommand,
	SaveTrackMapDraftCommand,
	TrackMapVersion,
} from './track-map.models';
import {
	TrackMapGateway,
	type TrackMapGatewayFailure,
} from './track-map-gateway';

type TrackMapOperation =
	| 'Create layout'
	| 'Create draft'
	| 'Save draft'
	| 'Rename layout'
	| 'Retire layout';

type State = {
	selectedLayoutId: string | null;
	selectedVersionId: string | null;
	localVersion: TrackMapVersion | null;
};

export type TrackMapCommandOutcome =
	| { readonly status: 'idle' }
	| { readonly status: 'pending'; readonly operation: TrackMapOperation }
	| { readonly status: 'succeeded'; readonly operation: TrackMapOperation }
	| {
			readonly status: 'failed';
			readonly operation: TrackMapOperation;
			readonly error: TrackMapGatewayFailure;
	  };

const initial: State = {
	selectedLayoutId: null,
	selectedVersionId: null,
	localVersion: null,
};

export const trackMapFailureMessage = (
	failure: TrackMapGatewayFailure,
): string => {
	if (failure.kind === 'unavailable')
		return 'Track maps are unavailable. Check your connection.';
	if (failure.kind === 'invalid-response')
		return 'The Track-map response was invalid.';
	if (failure.kind === 'rejected-response' && failure.detail)
		return failure.detail;
	return 'The Track-map request was rejected.';
};

export const TrackMapStore = signalStore(
	withState({
		...initial,
		outcome: { status: 'idle' } as TrackMapCommandOutcome,
	}),
	withProps(() => ({
		gateway: inject(TrackMapGateway),
	})),
	withComputed((store) => ({
		layouts: computed(() =>
			store.gateway.layouts.hasValue()
				? store.gateway.layouts.value().trackLayouts
				: [],
		),
		canManage: computed(
			() =>
				store.gateway.layouts.hasValue() &&
				store.gateway.layouts.value().canManage,
		),
		loading: computed(
			() =>
				store.gateway.layouts.isLoading() || store.gateway.version.isLoading(),
		),
		version: computed(() => {
			const selectedVersionId = store.selectedVersionId();
			if (!selectedVersionId) return null;
			const local = store.localVersion();
			if (local?.id === selectedVersionId) return local;
			if (!store.gateway.version.hasValue()) return null;
			const loaded = store.gateway.version.value();
			return loaded.id === selectedVersionId ? loaded : null;
		}),
		busy: computed(() => store.outcome().status === 'pending'),
		message: computed(() => {
			const outcome = store.outcome();
			return outcome.status === 'succeeded'
				? `${outcome.operation} saved.`
				: '';
		}),
		error: computed(() => {
			const outcome = store.outcome();
			return outcome.status === 'failed'
				? trackMapFailureMessage(outcome.error)
				: '';
		}),
		readError: computed(() => {
			if (store.gateway.layouts.error())
				return 'Track maps could not be loaded.';
			if (store.selectedVersionId() && store.gateway.version.error())
				return 'The selected Track map could not be loaded.';
			return '';
		}),
	})),
	withMethods((store) => {
		const activeLayout = (layoutId: string | null) =>
			store
				.layouts()
				.find((layout) => layout.id === layoutId && layout.status === 'active');
		const run = <T>(
			operation: TrackMapOperation,
			request: () => Observable<T>,
			success: (value: T) => void,
		): void => {
			patchState(store, { outcome: { status: 'pending', operation } });
			request()
				.pipe(
					tap((value) => {
						success(value);
						patchState(store, { outcome: { status: 'succeeded', operation } });
					}),
					catchError((error: TrackMapGatewayFailure) => {
						patchState(store, {
							outcome: { status: 'failed', operation, error },
						});
						return of(null);
					}),
				)
				.subscribe();
		};
		return {
			openLayout(layoutId: string): void {
				if (store.busy()) return;
				const layout = store.layouts().find((item) => item.id === layoutId);
				const version =
					layout?.status === 'active'
						? layout.mapVersions.find((item) => item.status === 'draft')
						: undefined;
				patchState(store, {
					selectedLayoutId: layoutId,
					selectedVersionId: version?.id ?? null,
					localVersion: null,
					outcome: { status: 'idle' },
				});
				store.gateway.selectVersion(version?.id ?? null);
			},
			refresh(): void {
				store.gateway.refresh();
				store.gateway.refreshVersion();
			},
			createLayout(command: CreateTrackLayoutCommand): void {
				if (store.busy() || !store.canManage()) return;
				run(
					'Create layout',
					() => store.gateway.createLayout(command.name),
					(layout) => {
						patchState(store, {
							selectedLayoutId: layout.id,
							selectedVersionId: null,
							localVersion: null,
						});
						store.gateway.selectVersion(null);
						store.gateway.refresh();
					},
				);
			},
			createDraft(command: CreateTrackMapDraftCommand): void {
				if (
					store.busy() ||
					!store.canManage() ||
					!activeLayout(command.layoutId)
				)
					return;
				run(
					'Create draft',
					() =>
						store.gateway.createDraft(
							command.layoutId,
							command.sourceVersionId,
						),
					(version) => {
						patchState(store, {
							selectedLayoutId: command.layoutId,
							selectedVersionId: version.id,
							localVersion: version,
						});
						store.gateway.selectVersion(version.id);
						store.gateway.refresh();
					},
				);
			},
			saveDraft(command: SaveTrackMapDraftCommand): void {
				const versionId = store.selectedVersionId();
				if (
					!versionId ||
					store.busy() ||
					!store.canManage() ||
					!activeLayout(store.selectedLayoutId())
				)
					return;
				run(
					'Save draft',
					() =>
						store.gateway.saveDraft({
							versionId,
							corners: command.corners,
						}),
					(version) => patchState(store, { localVersion: version }),
				);
			},
			renameLayout(command: RenameTrackLayoutCommand): void {
				const layoutId = store.selectedLayoutId();
				if (
					!layoutId ||
					store.busy() ||
					!store.canManage() ||
					!activeLayout(layoutId)
				)
					return;
				run(
					'Rename layout',
					() => store.gateway.renameLayout(layoutId, command.name),
					() => store.gateway.refresh(),
				);
			},
			retireLayout(): void {
				const layoutId = store.selectedLayoutId();
				if (
					!layoutId ||
					store.busy() ||
					!store.canManage() ||
					!activeLayout(layoutId)
				)
					return;
				run(
					'Retire layout',
					() => store.gateway.retireLayout(layoutId),
					() => {
						patchState(store, {
							selectedLayoutId: null,
							selectedVersionId: null,
							localVersion: null,
						});
						store.gateway.selectVersion(null);
						store.gateway.refresh();
					},
				);
			},
		};
	}),
);
