import { computed, effect, inject, untracked } from '@angular/core';
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
import type { PhotoMutationCommand } from '../car.models';
import type { PhotoCapture, PhotoView } from './photo-sync.models';
import { PhotoSyncGateway } from './photo-sync-gateway';

export type PhotoCaptureMutationOutcome =
	| Readonly<{ status: 'idle'; requestId: null }>
	| Readonly<{ status: 'pending' | 'succeeded'; requestId: string }>
	| Readonly<{ status: 'failed'; requestId: string; message: string }>;
/**
 * Application-wide coordinator for durable photo captures and edits. Publishes the
 * owner/session-fenced working gallery and replays dependency-ready operations
 * through PhotoSyncGateway across route changes. Storage commits precede local
 * success, and rejected captures keep their bytes for recovery.
 */
export const PhotoWorkspaceStore = signalStore(
	{ providedIn: 'root' },
	withState<{
		view: PhotoView | null;
		fence: OfflineWorkspaceFence | null;
		outcome: PhotoCaptureMutationOutcome;
		syncing: boolean;
		failure: string;
	}>({
		view: null,
		fence: null,
		outcome: { status: 'idle', requestId: null },
		syncing: false,
		failure: '',
	}),
	withProps(() => ({
		storage: inject(OfflineGarageStorage),
		offline: inject(OfflineWorkspaceStore),
		gateway: inject(PhotoSyncGateway),
		connectivity: inject(OfflineConnectivity),
		running: { value: false },
	})),
	withComputed((store) => ({
		available: computed(() => store.offline.hasSnapshot()),
		photos: computed(() =>
			store.fence()?.ownerKey === store.offline.ownerKey() &&
			store.fence()?.sessionKey === store.offline.sessionKey()
				? (store.view()?.photos ?? [])
				: [],
		),
		changes: computed(() =>
			store.fence()?.ownerKey === store.offline.ownerKey() &&
			store.fence()?.sessionKey === store.offline.sessionKey()
				? (store.view()?.changes ?? [])
				: [],
		),
		captures: computed(() =>
			store.fence()?.ownerKey === store.offline.ownerKey() &&
			store.fence()?.sessionKey === store.offline.sessionKey()
				? (store.view()?.captures ?? [])
				: [],
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
			patchState(store, { syncing: true, failure: '' });
			try {
				for (;;) {
					const view = await store.storage.photoView(identity);
					if (!matches(identity)) return;
					patchState(store, { view, fence: identity });
					const operation = (
						await store.storage.readyPhotoCaptures(identity)
					)[0];
					if (!matches(identity)) return;
					if (!operation) {
						const change = (await store.storage.readyPhotoChanges(identity))[0];
						if (!change || !matches(identity)) return;
						const result = await firstValueFrom(store.gateway.change(change));
						if (!matches(identity)) return;
						const next = await store.storage.recordPhotoChangeOutcome(
							result,
							identity,
						);
						if (!matches(identity)) return;
						store.offline.markOnline();
						store.connectivity.markRequestSucceeded();
						patchState(store, { view: next });
						continue;
					}
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
					patchState(store, { view: next });
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
						failure:
							'Photos remain saved here. Synchronization will retry when the connection returns.',
					});
			} finally {
				store.running.value = false;
				if (matches(identity)) patchState(store, { syncing: false });
				else if (store.offline.hasSnapshot())
					store.connectivity.scheduleRetry();
			}
		};
		const open = async (): Promise<void> => {
			const identity = fence();
			try {
				const view = await store.storage.photoView(identity);
				if (!matches(identity)) return;
				patchState(store, { view, fence: identity });
				await sync();
			} catch {
				if (matches(identity))
					patchState(store, {
						failure: 'Offline Photos could not be loaded.',
					});
			}
		};
		const mutate = async (
			command:
				| Readonly<{ carId: string; file: File }>
				| Readonly<{
						carId: string;
						capture: PhotoCapture;
						decision: 'retry' | 'discard';
				  }>
				| Readonly<{
						carId: string;
						edit: Exclude<PhotoMutationCommand, { kind: 'upload' }>;
				  }>,
			requestId: string,
		): Promise<void> => {
			const identity = fence();
			patchState(store, { outcome: { status: 'pending', requestId } });
			try {
				const view =
					'capture' in command
						? await store.storage.resolvePhotoCapture(
								command.capture,
								command.decision,
								identity,
							)
						: 'edit' in command
							? await store.storage.commitPhotoChange(
									command.carId,
									command.edit,
									identity,
								)
							: await store.storage.commitPhoto(
									command.carId,
									command.file,
									identity,
								);
				if (!matches(identity)) return;
				patchState(store, {
					view,
					fence: identity,
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
				if (matches(identity)) patchState(store, { view, fence: identity });
			} catch {
				if (matches(identity))
					patchState(store, {
						failure:
							'Photo metadata could not be refreshed. Reopen the gallery when connected.',
					});
			}
		};

		return {
			refresh(replacedPhotoId?: string): void {
				void refresh(replacedPhotoId);
			},
			open(): void {
				void open();
			},
			synchronize(): void {
				void sync();
			},
			mutate(
				command: Readonly<{
					requestId: string;
					change:
						| Readonly<{ carId: string; file: File }>
						| Readonly<{
								carId: string;
								capture: PhotoCapture;
								decision: 'retry' | 'discard';
						  }>
						| Readonly<{
								carId: string;
								edit: Exclude<PhotoMutationCommand, { kind: 'upload' }>;
						  }>;
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
						view: null,
						fence: null,
						outcome: { status: 'idle', requestId: null },
						syncing: false,
						failure: '',
					});
					if (available) store.open();
				});
			});
			effect(() => {
				store.connectivity.retryHint();
				untracked(() => store.synchronize());
			});
		},
	})),
);
