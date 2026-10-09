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
import { CarWorkspaceStore } from '../garage/car-sync/car-workspace-store';
import { OfflineConnectivity } from '../offline/offline-connectivity';
import {
	OfflineGarageStorage,
	type OfflineWorkspaceFence,
} from '../offline/offline-garage-storage';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import type { PendingVoiceCapture, VoiceGatewayFailure } from './voice.models';
import { VoiceLegacyMigration } from './voice-legacy-migration';
import type { VoiceWorkingCopy } from './voice-sync.models';
import { VoiceSyncGateway } from './voice-sync-gateway';
export type VoiceLocalOutcome =
	| Readonly<{ status: 'idle'; requestId: null }>
	| Readonly<{ status: 'pending'; requestId: string }>
	| Readonly<{ status: 'succeeded'; requestId: string }>
	| Readonly<{ status: 'failed'; requestId: string; message: string }>;
export const VoiceWorkspaceStore = signalStore(
	{ providedIn: 'root' },
	withState<{
		view: VoiceWorkingCopy | null;
		fence: OfflineWorkspaceFence | null;
		outcome: VoiceLocalOutcome;
		failure: string;
		syncing: boolean;
	}>({
		view: null,
		fence: null,
		outcome: { status: 'idle', requestId: null },
		failure: '',
		syncing: false,
	}),
	withProps(() => ({
		storage: inject(OfflineGarageStorage),
		offline: inject(OfflineWorkspaceStore),
		carsWorkspace: inject(CarWorkspaceStore),
		connectivity: inject(OfflineConnectivity),
		gateway: inject(VoiceSyncGateway),
		migration: inject(VoiceLegacyMigration),
		running: { value: false },
	})),
	withComputed((store) => ({
		available: computed(() => store.offline.hasSnapshot()),
		current: computed(() =>
			store.fence()?.ownerKey === store.offline.ownerKey() &&
			store.fence()?.sessionKey === store.offline.sessionKey()
				? store.view()
				: null,
		),
		remoteAvailable: computed(() => !store.offline.networkUnavailable()),
		cars: computed(() =>
			store.carsWorkspace.cars().filter((car) => !car.archivedAt),
		),
	})),
	withComputed((store) => ({
		captures: computed(
			() =>
				store
					.current()
					?.captures.filter((capture) => capture.phase !== 'retained') ?? [],
		),
		updates: computed(() => {
			const current = store.current();
			const pending = new Set(
				current?.captures
					.filter((capture) => capture.phase !== 'retained')
					.map((capture) => capture.id),
			);
			return current?.updates.filter((update) => !pending.has(update.id)) ?? [];
		}),
	})),
	withMethods((store) => {
		const fence = (): OfflineWorkspaceFence => ({
			ownerKey: store.offline.ownerKey(),
			sessionKey: store.offline.sessionKey(),
		});
		const matches = (identity: OfflineWorkspaceFence) =>
			store.offline.hasSnapshot() &&
			identity.ownerKey === store.offline.ownerKey() &&
			identity.sessionKey === store.offline.sessionKey();
		const publish = (
			view: VoiceWorkingCopy,
			identity: OfflineWorkspaceFence,
		) => {
			if (matches(identity)) patchState(store, { view, fence: identity });
		};
		const sync = async (): Promise<void> => {
			if (store.running.value || !store.offline.hasSnapshot()) return;
			const identity = fence();
			store.running.value = true;
			patchState(store, { syncing: true });
			try {
				for (;;) {
					const ready = await store.storage.readyVoice(identity);
					if (!matches(identity)) return;
					const capture = ready[0];
					if (!capture) return;
					try {
						if (capture.phase === 'upload') {
							const response = await firstValueFrom(
								store.gateway.upload(capture),
							);
							if (!matches(identity)) return;
							store.offline.markOnline();
							store.connectivity.markRequestSucceeded();
							publish(
								await store.storage.changeVoice(
									capture.id,
									{
										phase:
											response.voiceUpdate.status === 'needs-review' ||
											response.voiceUpdate.status === 'saved'
												? 'retained'
												: 'processing',
										remote: response.voiceUpdate,
										status: 'queued',
										error: null,
									},
									identity,
								),
								identity,
							);
						} else {
							const response = await firstValueFrom(
								store.gateway.process(capture.id),
							);
							if (!matches(identity)) return;
							store.offline.markOnline();
							store.connectivity.markRequestSucceeded();
							publish(
								await store.storage.changeVoice(
									capture.id,
									{
										phase:
											response.voiceUpdate.status === 'processing'
												? 'processing'
												: 'retained',
										remote: response.voiceUpdate,
										status: 'queued',
										error: null,
									},
									identity,
								),
								identity,
							);
							if (response.voiceUpdate.status === 'processing') {
								store.connectivity.scheduleRetry();
								return;
							}
						}
					} catch (error: unknown) {
						if (!matches(identity)) return;
						const failure = error as VoiceGatewayFailure | null;
						if (failure?.kind === 'unavailable') {
							store.offline.markOffline();
							store.connectivity.scheduleRetry();
							return;
						}
						const message =
							failure?.kind === 'rejected-response'
								? failure.message
								: 'Voice processing needs attention. The original note remains on this device.';
						publish(
							await store.storage.changeVoice(
								capture.id,
								{ status: 'failed', error: message },
								identity,
							),
							identity,
						);
					}
				}
			} catch {
				if (matches(identity))
					patchState(store, {
						failure: 'Voice notes could not be read from this device.',
					});
				store.connectivity.scheduleRetry();
			} finally {
				store.running.value = false;
				if (matches(identity)) patchState(store, { syncing: false });
				else if (store.offline.hasSnapshot())
					store.connectivity.scheduleRetry();
			}
		};
		const open = async () => {
			const identity = fence();
			try {
				await store.migration.migrate(store.offline.ownerEmail(), identity);
				if (!matches(identity)) return;
				publish(await store.storage.voiceView(identity), identity);
				await sync();
			} catch {
				if (matches(identity))
					patchState(store, {
						failure:
							'Queued Voice notes could not be opened safely. The originals have been retained.',
					});
			}
		};
		const keep = async (capture: PendingVoiceCapture, requestId: string) => {
			const identity = fence();
			patchState(store, { outcome: { status: 'pending', requestId } });
			try {
				const view = await store.storage.keepVoice(capture, identity);
				if (!matches(identity)) return;
				publish(view, identity);
				patchState(store, { outcome: { status: 'succeeded', requestId } });
				await sync();
			} catch {
				if (matches(identity))
					patchState(store, {
						outcome: {
							status: 'failed',
							requestId,
							message: 'The note could not be stored safely on this device.',
						},
					});
			}
		};
		const discard = async (id: string, requestId: string) => {
			const identity = fence();
			patchState(store, { outcome: { status: 'pending', requestId } });
			try {
				publish(
					await store.storage.changeVoice(id, 'discard', identity),
					identity,
				);
				if (matches(identity))
					patchState(store, { outcome: { status: 'succeeded', requestId } });
			} catch {
				if (matches(identity))
					patchState(store, {
						outcome: {
							status: 'failed',
							requestId,
							message:
								'The pending recording could not be discarded from this device.',
						},
					});
			}
		};
		const retry = async () => {
			const identity = fence();
			try {
				const view = await store.storage.voiceView(identity);
				for (const capture of view.captures)
					if (capture.status === 'failed')
						await store.storage.changeVoice(
							capture.id,
							{ status: 'queued', error: null },
							identity,
						);
				if (matches(identity)) {
					publish(await store.storage.voiceView(identity), identity);
					await sync();
				}
			} catch {
				if (matches(identity))
					patchState(store, {
						failure:
							'Pending Voice notes remain saved here. Retry when storage is available.',
					});
			}
		};
		const refresh = async () => {
			const identity = fence();
			try {
				const updates = await firstValueFrom(store.gateway.load());
				if (matches(identity))
					publish(
						await store.storage.refreshVoice(updates, identity),
						identity,
					);
			} catch {
				if (matches(identity))
					patchState(store, {
						failure:
							'Voice history remains saved here. Remote refresh is unavailable.',
					});
			}
		};
		return {
			open() {
				void open();
			},
			synchronize() {
				void sync();
			},
			keep(
				command: Readonly<{ capture: PendingVoiceCapture; requestId: string }>,
			) {
				void keep(command.capture, command.requestId);
			},
			discard(command: Readonly<{ id: string; requestId: string }>) {
				void discard(command.id, command.requestId);
			},
			retry() {
				void retry();
			},
			refresh() {
				void refresh();
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
						failure: '',
						syncing: false,
					});
					if (available) store.open();
				});
			});
			effect(() => {
				store.connectivity.retryHint();
				store.carsWorkspace.operations();
				store.carsWorkspace.driveOperations();
				untracked(() => store.synchronize());
			});
		},
	})),
);
