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
import { OfflineConnectivity } from '../offline/offline-connectivity';
import {
	OfflineGarageStorage,
	type OfflineWorkspaceFence,
} from '../offline/offline-garage-storage';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import type { SettingsCommand, SettingsView } from './settings-sync.models';
import {
	type SettingsSyncFailure,
	SettingsSyncGateway,
} from './settings-sync-gateway';
import { readySettingsOperations } from './settings-sync-rules';

export type SettingsMutationOutcome =
	| Readonly<{ status: 'idle'; requestId: null }>
	| Readonly<{ status: 'pending' | 'succeeded'; requestId: string }>
	| Readonly<{ status: 'failed'; requestId: string; message: string }>;
/**
 * Retains and replays timezone/invite intent independently of the Settings route.
 * Publishes an owner/session-fenced local view, commits commands before success,
 * and leaves terminal rejection/conflict available for review while unrelated
 * operations continue through SettingsSyncGateway.
 */
export const SettingsWorkspaceStore = signalStore(
	{ providedIn: 'root' },
	withState<{
		view: SettingsView | null;
		fence: OfflineWorkspaceFence | null;
		outcome: SettingsMutationOutcome;
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
		gateway: inject(SettingsSyncGateway),
		connectivity: inject(OfflineConnectivity),
		running: { value: false },
	})),
	withComputed((store) => ({
		available: computed(() => store.offline.hasSnapshot()),
		current: computed(() =>
			store.fence()?.ownerKey === store.offline.ownerKey() &&
			store.fence()?.sessionKey === store.offline.sessionKey()
				? (store.view()?.current ?? null)
				: null,
		),
		operations: computed(() =>
			store.fence()?.ownerKey === store.offline.ownerKey() &&
			store.fence()?.sessionKey === store.offline.sessionKey()
				? (store.view()?.operations ?? [])
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
					const view = await store.storage.settingsSyncView();
					if (!matches(identity)) return;
					patchState(store, { view, fence: identity });
					const operation = readySettingsOperations(view?.operations ?? [])[0];
					if (!operation) return;
					const outcome = await firstValueFrom(store.gateway.apply(operation));
					if (!matches(identity)) return;
					store.offline.markOnline();
					store.connectivity.markRequestSucceeded();
					const next = await store.storage.recordSettingsOutcome(
						outcome,
						identity,
					);
					if (!matches(identity)) return;
					patchState(store, { view: next });
				}
			} catch (error: unknown) {
				if (
					matches(identity) &&
					(error as SettingsSyncFailure | null)?.kind === 'unavailable'
				)
					store.offline.markOffline();
				store.connectivity.scheduleRetry();
				if (matches(identity))
					patchState(store, {
						failure:
							'Settings remain saved here. Synchronization will retry when the connection returns.',
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
				const view = await store.storage.settingsSyncView();
				if (!matches(identity)) return;
				patchState(store, { view, fence: identity });
				await sync();
			} catch {
				if (matches(identity))
					patchState(store, {
						failure: 'Offline Settings could not be loaded.',
					});
			}
		};
		const mutate = async (
			command: SettingsCommand,
			requestId: string,
		): Promise<void> => {
			const identity = fence();
			patchState(store, { outcome: { status: 'pending', requestId } });
			try {
				const view = await store.storage.commitSettings(command, identity);
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
								'Settings could not be saved on this device. Your change has not been retained.',
						},
					});
			}
		};
		return {
			open(): void {
				void open();
			},
			synchronize(): void {
				void sync();
			},
			mutate(
				command: Readonly<{ requestId: string; change: SettingsCommand }>,
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
