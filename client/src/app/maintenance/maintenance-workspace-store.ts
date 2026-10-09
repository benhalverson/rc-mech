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
import { calculateMaintenanceDue } from '../../../../shared/maintenance-due';
import { CarWorkspaceStore } from '../garage/car-sync/car-workspace-store';
import { OfflineConnectivity } from '../offline/offline-connectivity';
import {
	OFFLINE_CURRENT_TIME,
	OfflineGarageStorage,
	type OfflineWorkspaceFence,
} from '../offline/offline-garage-storage';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import type {
	MaintenanceCommand,
	MaintenanceView,
} from './maintenance-sync.models';
import {
	MaintenanceSyncGateway,
	type MaintenanceSyncGatewayFailure,
} from './maintenance-sync-gateway';

export type MaintenanceMutationOutcome =
	| Readonly<{ status: 'idle'; requestId: null }>
	| Readonly<{ status: 'pending'; requestId: string }>
	| Readonly<{ status: 'succeeded'; requestId: string }>
	| Readonly<{ status: 'failed'; requestId: string; message: string }>;
export const MaintenanceWorkspaceStore = signalStore(
	{ providedIn: 'root' },
	withState<{
		view: MaintenanceView | null;
		fence: OfflineWorkspaceFence | null;
		outcome: MaintenanceMutationOutcome;
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
		carWorkspace: inject(CarWorkspaceStore),
		now: inject(OFFLINE_CURRENT_TIME),
		offline: inject(OfflineWorkspaceStore),
		gateway: inject(MaintenanceSyncGateway),
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
	withComputed((store) => ({
		cars: computed(() => store.carWorkspace.cars()),
		plans: computed(() => {
			const current = store.current();
			if (!current) return [];
			const counts = new Map(
				store.carWorkspace
					.driveCollections()
					.map((collection) => [
						collection.carId,
						collection.sessions.filter((session) => !session.deletedAt).length,
					]),
			);
			return current.collections.flatMap((collection) =>
				collection.plans.map((plan) => ({
					...plan,
					...calculateMaintenanceDue({
						status: plan.status,
						baselineAt: plan.baselineAt,
						baselineSessionCount: plan.baselineSessionCount,
						intervalUnit: plan.intervalUnit,
						intervalValue: plan.intervalValue,
						intervalSessions: plan.intervalSessions,
						currentSessionCount: counts.get(plan.carId) ?? 0,
						now: new Date(store.now()).toISOString(),
						timezone: current.timezone,
					}),
				})),
			);
		}),
		records: computed(
			() =>
				store
					.current()
					?.collections.flatMap((collection) => collection.records) ?? [],
		),
		components: computed(() => store.current()?.components ?? []),
		timezone: computed(() => store.current()?.timezone ?? 'UTC'),
		syncMessage: computed(() =>
			store
				.operations()
				.map((operation) =>
					operation.status === 'pending'
						? 'Pending sync'
						: operation.status === 'conflict'
							? `Sync conflict: ${operation.feedback?.message ?? 'Review this change.'}`
							: `Needs attention: ${operation.feedback?.message ?? 'Review this change.'}`,
				)
				.join('; '),
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
					const view = await store.storage.maintenanceSyncView(identity);
					if (!matches(identity)) return;
					patchState(store, { view, fence: identity });
					const operation = (
						await store.storage.readyMaintenanceOperations(identity)
					)[0];
					if (!operation || !matches(identity)) return;
					const outcome = await firstValueFrom(store.gateway.apply(operation));
					if (!matches(identity)) return;
					store.offline.markOnline();
					store.connectivity.markRequestSucceeded();
					const next = await store.storage.recordMaintenanceOutcome(
						outcome,
						identity,
					);
					if (!matches(identity)) return;
					patchState(store, { view: next });
				}
			} catch (error: unknown) {
				if (
					matches(identity) &&
					(error as MaintenanceSyncGatewayFailure | null)?.kind ===
						'unavailable'
				)
					store.offline.markOffline();
				store.connectivity.scheduleRetry();
				if (matches(identity))
					patchState(store, {
						failure:
							'Maintenance remain saved here. Synchronization will retry when the connection returns.',
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
				const view = await store.storage.maintenanceSyncView(identity);
				if (!matches(identity)) return;
				patchState(store, { view, fence: identity });
				await sync();
			} catch {
				if (matches(identity))
					patchState(store, {
						failure: 'Offline Maintenance could not be loaded.',
					});
			}
		};
		const mutate = async (
			command: MaintenanceCommand,
			requestId: string,
		): Promise<void> => {
			const identity = fence();
			patchState(store, { outcome: { status: 'pending', requestId } });
			try {
				const view = await store.storage.commitMaintenance(command, identity);
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
								'Maintenance could not be saved on this device. Your change has not been retained.',
						},
					});
			}
		};
		const refresh = async (): Promise<void> => {
			const identity = fence();
			try {
				const incoming = await firstValueFrom(store.gateway.load());
				if (!matches(identity)) return;
				const view = await store.storage.refreshMaintenance(incoming, identity);
				if (matches(identity))
					patchState(store, { view, fence: identity, failure: '' });
			} catch {
				if (matches(identity))
					patchState(store, {
						failure:
							'Maintenance remains saved here. Remote refresh is unavailable.',
					});
			}
		};

		return {
			refresh(): void {
				void refresh();
			},
			open(): void {
				void open();
			},
			synchronize(): void {
				void sync();
			},
			mutate(
				command: Readonly<{ requestId: string; change: MaintenanceCommand }>,
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
				store.carWorkspace.operations();
				store.carWorkspace.driveOperations();
				untracked(() => store.synchronize());
			});
		},
	})),
);
