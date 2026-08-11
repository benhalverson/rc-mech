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
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, EMPTY, from, switchMap, tap } from 'rxjs';
import type { GarageCar } from '../garage/garage.models';
import { OfflineConnectivity } from './offline-connectivity';
import type { OfflineGarageSnapshot } from './offline-garage-storage';
import type { OfflineOwner } from './offline-owner';
import { OfflineWorkspaceAccess } from './offline-workspace-access';

type OfflineWorkspaceStatus =
	| 'idle'
	| 'preparing'
	| 'ready'
	| 'offline'
	| 'offline-unavailable'
	| 'online-only';

type OnlineOnlyReason = 'unsupported' | 'preparation-failed' | null;

type OfflineWorkspaceState = {
	status: OfflineWorkspaceStatus;
	onlineOnlyReason: OnlineOnlyReason;
	networkUnavailable: boolean;
	ownerEmail: string;
	cars: readonly GarageCar[];
};

type PrepareOfflineWorkspaceCommand = Readonly<{ owner: OfflineOwner }>;
type OpenOfflineWorkspaceCommand = Readonly<{
	snapshot: OfflineGarageSnapshot;
}>;

export const OfflineWorkspaceStore = signalStore(
	{ providedIn: 'root' },
	withState<OfflineWorkspaceState>({
		status: 'idle',
		onlineOnlyReason: null,
		networkUnavailable: false,
		ownerEmail: '',
		cars: [],
	}),
	withProps(() => ({
		access: inject(OfflineWorkspaceAccess),
		connectivity: inject(OfflineConnectivity),
	})),
	withComputed((store) => ({
		hasSnapshot: computed(
			() => store.status() === 'ready' || store.status() === 'offline',
		),
		message: computed(() => {
			const status = store.status();
			if (status === 'idle') return '';
			if (status === 'preparing') return 'Preparing offline access…';
			if (status === 'ready') return 'Offline ready';
			if (status === 'offline') return 'Offline—prepared Garage is read-only';
			if (status === 'offline-unavailable')
				return 'Offline—this browser has no prepared Garage.';
			return store.onlineOnlyReason() === 'unsupported'
				? 'Offline access is unavailable in this browser. Chassis Notes remains available while connected.'
				: 'Offline access could not be prepared. Chassis Notes remains available while connected.';
		}),
	})),
	withMethods((store) => {
		const prepare = rxMethod<PrepareOfflineWorkspaceCommand>((commands$) =>
			commands$.pipe(
				switchMap(({ owner }) => {
					patchState(store, {
						status: 'preparing',
						onlineOnlyReason: null,
						ownerEmail: owner.email,
						cars: [],
					});
					return from(store.access.prepare(owner)).pipe(
						tap((result) => {
							if (result.kind === 'unsupported') {
								patchState(store, {
									status: untracked(store.networkUnavailable)
										? 'offline-unavailable'
										: 'online-only',
									onlineOnlyReason: 'unsupported',
								});
								return;
							}
							patchState(store, {
								status: 'ready',
								onlineOnlyReason: null,
								networkUnavailable: false,
								ownerEmail: result.snapshot.ownerEmail,
								cars: result.snapshot.cars,
							});
						}),
						catchError(() => {
							patchState(store, {
								status: untracked(store.networkUnavailable)
									? 'offline-unavailable'
									: 'online-only',
								onlineOnlyReason: 'preparation-failed',
								cars: [],
							});
							return EMPTY;
						}),
					);
				}),
			),
		);

		return {
			markOffline(): void {
				const status = untracked(store.status);
				if (status === 'ready')
					patchState(store, { status: 'offline', networkUnavailable: true });
				else if (status === 'online-only')
					patchState(store, {
						status: 'offline-unavailable',
						networkUnavailable: true,
					});
				else patchState(store, { networkUnavailable: true });
			},
			markOnline(): void {
				const status = untracked(store.status);
				if (status === 'offline')
					patchState(store, { status: 'ready', networkUnavailable: false });
				else if (status === 'offline-unavailable')
					patchState(store, {
						status: 'online-only',
						networkUnavailable: false,
					});
				else patchState(store, { networkUnavailable: false });
			},
			prepare(command: PrepareOfflineWorkspaceCommand): void {
				prepare(command);
			},
			openOffline({ snapshot }: OpenOfflineWorkspaceCommand): void {
				patchState(store, {
					status: 'offline',
					onlineOnlyReason: null,
					networkUnavailable: true,
					ownerEmail: snapshot.ownerEmail,
					cars: snapshot.cars,
				});
			},
		};
	}),
	withHooks({
		onInit(store) {
			let wasOnline = store.connectivity.online();
			effect(() => {
				const online = store.connectivity.online();
				const status = store.status();
				const reconnected = online && !wasOnline;
				wasOnline = online;
				if (
					!online &&
					(status === 'ready' ||
						status === 'online-only' ||
						status === 'preparing')
				)
					store.markOffline();
				else if (
					reconnected &&
					(status === 'offline' || status === 'offline-unavailable')
				)
					store.markOnline();
			});
		},
	}),
);
