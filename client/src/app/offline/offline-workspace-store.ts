import { computed, inject, untracked } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, EMPTY, from, switchMap, tap } from 'rxjs';
import type { GarageCar } from '../garage/garage.models';
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
	ownerKey: string;
	ownerEmail: string;
	sessionKey: string;
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
		ownerKey: '',
		ownerEmail: '',
		sessionKey: '',
		cars: [],
	}),
	withProps(() => ({
		access: inject(OfflineWorkspaceAccess),
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
			if (status === 'offline')
				return 'Offline—changes will be saved here and sync when connection returns.';
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
						ownerKey: owner.key,
						ownerEmail: owner.email,
						sessionKey: owner.sessionKey,
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
								ownerKey: result.snapshot.ownerKey,
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
			hasSnapshotFor(owner: OfflineOwner): boolean {
				return (
					untracked(store.hasSnapshot) &&
					untracked(store.ownerKey) === owner.key &&
					untracked(store.sessionKey) === owner.sessionKey
				);
			},
			setCars(cars: readonly GarageCar[]): void {
				patchState(store, { cars });
			},
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
					ownerKey: snapshot.ownerKey,
					ownerEmail: snapshot.ownerEmail,
					sessionKey: '',
					cars: snapshot.cars,
				});
			},
		};
	}),
);
