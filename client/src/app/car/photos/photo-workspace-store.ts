import { computed, effect, inject, resource, untracked } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withHooks,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { OfflineConnectivity } from '../../offline/offline-connectivity';
import {
	OfflineGarageStorage,
	type OfflineWorkspaceFence,
} from '../../offline/offline-garage-storage';
import { OfflineWorkspaceStore } from '../../offline/offline-workspace-store';
import { PhotoSyncGateway } from './photo-sync-gateway';

export type PhotoCaptureMutationOutcome =
	| Readonly<{ status: 'idle'; requestId: null }>
	| Readonly<{ status: 'pending' | 'succeeded'; requestId: string }>
	| Readonly<{ status: 'failed'; requestId: string; message: string }>;
/**
 * Application-wide coordinator for durable photo captures. Publishes the
 * owner/session-fenced working gallery and replays dependency-ready operations
 * through PhotoSyncGateway across route changes. Storage commits precede local
 * success, and rejected captures keep their bytes for recovery. A resource owns
 * local hydration and read errors; explicit mutations update it only after fenced
 * transactions commit. Resource loaders never drain the command queue.
 */
export const PhotoWorkspaceStore = signalStore(
	{ providedIn: 'root' },
	withState<{
		outcome: PhotoCaptureMutationOutcome;
		syncing: boolean;
		syncFailure: string;
	}>({
		outcome: { status: 'idle', requestId: null },
		syncing: false,
		syncFailure: '',
	}),
	withProps(() => ({
		storage: inject(OfflineGarageStorage),
		offline: inject(OfflineWorkspaceStore),
		gateway: inject(PhotoSyncGateway),
		connectivity: inject(OfflineConnectivity),
		running: { value: false },
	})),
	withProps((store) => ({
		view: resource({
			params: () =>
				store.offline.hasSnapshot()
					? {
							ownerKey: store.offline.ownerKey(),
							sessionKey: store.offline.sessionKey(),
						}
					: undefined,
			loader: ({ params }) => store.storage.photoView(params),
		}),
	})),
	withComputed((store) => ({
		available: computed(() => store.offline.hasSnapshot()),
		photos: computed(() =>
			store.view.hasValue() ? (store.view.value()?.photos ?? []) : [],
		),
		captures: computed(() =>
			store.view.hasValue() ? (store.view.value()?.captures ?? []) : [],
		),
		failure: computed(() =>
			store.view.error()
				? 'Offline Photos could not be loaded.'
				: store.syncFailure(),
		),
	})),
	withMethods((store) => {
		const fence = (): OfflineWorkspaceFence => ({
			ownerKey: store.offline.ownerKey(),
			sessionKey: store.offline.sessionKey(),
		});
		const matches = (identity: OfflineWorkspaceFence): boolean =>
			identity.ownerKey === store.offline.ownerKey() &&
			identity.sessionKey === store.offline.sessionKey() &&
			store.offline.hasSnapshot();
		const sync = async (): Promise<void> => {
			if (store.running.value || !store.offline.hasSnapshot()) return;
			const identity = fence();
			store.running.value = true;
			patchState(store, { syncing: true, syncFailure: '' });
			try {
				for (;;) {
					const operation = (
						await store.storage.readyPhotoCaptures(identity)
					)[0];
					if (!operation || !matches(identity)) return;
					const outcome = await firstValueFrom(store.gateway.apply(operation));
					if (!matches(identity)) return;
					store.offline.markOnline();
					store.connectivity.markRequestSucceeded();
					const photos =
						outcome.outcome === 'applied'
							? await firstValueFrom(store.gateway.metadata())
							: [];
					if (!matches(identity)) return;
					const next = await store.storage.recordPhotoOutcome(
						outcome,
						photos,
						identity,
					);
					if (!matches(identity)) return;
					store.view.set(next);
				}
			} catch (error: unknown) {
				if (
					matches(identity) &&
					(error as Readonly<{ kind: string }> | null)?.kind === 'unavailable'
				)
					store.offline.markOffline();
				store.connectivity.scheduleRetry();
				if (matches(identity))
					patchState(store, {
						syncFailure:
							'Photos remain saved here. Synchronization will retry when the connection returns.',
					});
			} finally {
				store.running.value = false;
				if (matches(identity)) patchState(store, { syncing: false });
				else if (store.offline.hasSnapshot())
					store.connectivity.scheduleRetry();
			}
		};
		const mutate = async (
			command: Readonly<{ carId: string; file: File }>,
			requestId: string,
		): Promise<void> => {
			const identity = fence();
			patchState(store, { outcome: { status: 'pending', requestId } });
			try {
				const view = await store.storage.commitPhoto(
					command.carId,
					command.file,
					identity,
				);
				if (!matches(identity)) return;
				store.view.set(view);
				patchState(store, {
					outcome: { status: 'succeeded', requestId },
				});
				await sync();
			} catch {
				if (matches(identity))
					patchState(store, {
						outcome: {
							status: 'failed',
							requestId,
							message:
								'Photos could not be saved on this device. Your change has not been retained.',
						},
					});
			}
		};
		const refresh = async (replacedPhotoId?: string): Promise<void> => {
			const identity = fence();
			try {
				const photos = await firstValueFrom(store.gateway.metadata());
				if (!matches(identity)) return;
				const view = await store.storage.refreshPhotos(
					photos,
					replacedPhotoId,
					identity,
				);
				if (matches(identity)) store.view.set(view);
			} catch {
				if (matches(identity))
					patchState(store, {
						syncFailure:
							'Photo metadata could not be refreshed. Reopen the gallery when connected.',
					});
			}
		};

		return {
			refresh(replacedPhotoId?: string): void {
				void refresh(replacedPhotoId);
			},
			open(): void {
				store.view.reload();
				void sync();
			},
			synchronize(): void {
				void sync();
			},
			mutate(
				command: Readonly<{
					requestId: string;
					change: Readonly<{ carId: string; file: File }>;
				}>,
			): void {
				void mutate(command.change, command.requestId);
			},
		};
	}),
	withHooks((store) => ({
		onInit() {
			effect(() => {
				store.offline.ownerKey();
				store.offline.sessionKey();
				const available = store.offline.hasSnapshot();
				untracked(() => {
					patchState(store, {
						outcome: { status: 'idle', requestId: null },
						syncing: false,
						syncFailure: '',
					});
					if (available) store.synchronize();
				});
			});
			effect(() => {
				store.connectivity.retryHint();
				untracked(() => store.synchronize());
			});
		},
	})),
);
