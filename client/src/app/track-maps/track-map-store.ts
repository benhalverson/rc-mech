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
import type { TrackCorner, TrackMapVersion } from './track-map.models';
import {
	TrackMapGateway,
	type TrackMapGatewayFailure,
} from './track-map-gateway';

type State = {
	selectedLayoutId: string | null;
	selectedVersionId: string | null;
	version: TrackMapVersion | null;
	busy: boolean;
	error: string;
	message: string;
};
const initial: State = {
	selectedLayoutId: null,
	selectedVersionId: null,
	version: null,
	busy: false,
	error: '',
	message: '',
};
export type TrackMapCommandOutcome = {
	status: 'idle' | 'pending' | 'succeeded' | 'failed';
	operation: string;
	error?: TrackMapGatewayFailure;
};

export const TrackMapStore = signalStore(
	withState({
		...initial,
		outcome: { status: 'idle', operation: '' } as TrackMapCommandOutcome,
	}),
	withProps(() => ({
		gateway: inject(TrackMapGateway),
	})),
	withComputed((store) => ({
		layouts: computed(() =>
			store.gateway.layouts.hasValue() ? store.gateway.layouts.value() : [],
		),
		loading: computed(() => store.gateway.layouts.isLoading()),
		readError: computed(() =>
			store.gateway.layouts.error()
				? 'Track maps could not be loaded.'
				: store.error(),
		),
	})),
	withMethods((store) => {
		const run = <T>(
			operation: string,
			request: () => Observable<T>,
			success: (value: T) => void,
		) => {
			patchState(store, {
				busy: true,
				error: '',
				message: '',
				outcome: { status: 'pending', operation },
			});
			return request().pipe(
				tap((value) => {
					success(value);
					patchState(store, {
						busy: false,
						message: `${operation} saved.`,
						outcome: { status: 'succeeded', operation },
					});
				}),
				catchError((error: TrackMapGatewayFailure) => {
					patchState(store, {
						busy: false,
						error: error.message,
						outcome: { status: 'failed', operation, error },
					});
					return of(null);
				}),
			);
		};
		return {
			selectLayout(layoutId: string): void {
				patchState(store, {
					selectedLayoutId: layoutId,
					selectedVersionId: null,
					version: null,
					error: '',
					message: '',
				});
			},
			loadVersion(versionId: string): void {
				patchState(store, {
					selectedVersionId: versionId,
					busy: true,
					error: '',
				});
				store.gateway.getVersion(versionId).subscribe({
					next: (version) =>
						patchState(store, {
							version,
							selectedLayoutId: version.layoutId,
							busy: false,
						}),
					error: (error: TrackMapGatewayFailure) =>
						patchState(store, { busy: false, error: error.message }),
				});
			},
			refresh(): void {
				store.gateway.refresh();
			},
			createLayout(name: string): void {
				run(
					'Create layout',
					() => store.gateway.createLayout(name),
					(layout) => {
						patchState(store, { selectedLayoutId: layout.id });
						store.gateway.refresh();
					},
				).subscribe();
			},
			createDraft(layoutId: string, sourceVersionId?: string): void {
				run(
					'Create draft',
					() => store.gateway.createDraft(layoutId, sourceVersionId),
					(version) => {
						patchState(store, {
							selectedLayoutId: layoutId,
							selectedVersionId: version.id,
							version,
						});
					},
				).subscribe();
			},
			saveDraft(corners: readonly TrackCorner[]): void {
				const versionId = store.selectedVersionId();
				if (!versionId) return;
				run(
					'Save draft',
					() => store.gateway.saveDraft({ versionId, corners }),
					(version) => patchState(store, { version }),
				).subscribe();
			},
			renameLayout(name: string): void {
				const layoutId = store.selectedLayoutId();
				if (!layoutId) return;
				run(
					'Rename layout',
					() => store.gateway.renameLayout(layoutId, name),
					() => store.gateway.refresh(),
				).subscribe();
			},
			retireLayout(): void {
				const layoutId = store.selectedLayoutId();
				if (!layoutId) return;
				run(
					'Retire layout',
					() => store.gateway.retireLayout(layoutId),
					() => {
						patchState(store, {
							selectedLayoutId: null,
							selectedVersionId: null,
							version: null,
						});
						store.gateway.refresh();
					},
				).subscribe();
			},
		};
	}),
);
