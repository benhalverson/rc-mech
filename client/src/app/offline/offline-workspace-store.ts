import { computed, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, EMPTY, exhaustMap, from, tap } from 'rxjs';
import type { GarageCar } from '../garage/garage.models';
import type { OfflineGarageSnapshot } from './offline-garage-storage';
import type { OfflineOwner } from './offline-owner';
import { OfflineWorkspaceAccess } from './offline-workspace-access';

type OfflineWorkspaceStatus =
	| 'idle'
	| 'preparing'
	| 'ready'
	| 'offline'
	| 'online-only';

type OnlineOnlyReason = 'unsupported' | 'preparation-failed' | null;

type OfflineWorkspaceState = {
	status: OfflineWorkspaceStatus;
	onlineOnlyReason: OnlineOnlyReason;
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
		ownerEmail: '',
		cars: [],
	}),
	withProps(() => ({ access: inject(OfflineWorkspaceAccess) })),
	withComputed((store) => ({
		hasSnapshot: computed(
			() => store.status() === 'ready' || store.status() === 'offline',
		),
		message: computed(() => {
			const status = store.status();
			if (status === 'idle') return '';
			if (status === 'preparing') return 'Preparing offline access…';
			if (status === 'ready') return 'Offline ready';
			if (status === 'offline') return 'Offline—changes will sync later';
			return store.onlineOnlyReason() === 'unsupported'
				? 'Offline access is unavailable in this browser. Chassis Notes remains available while connected.'
				: 'Offline access could not be prepared. Chassis Notes remains available while connected.';
		}),
	})),
	withMethods((store) => {
		const prepare = rxMethod<PrepareOfflineWorkspaceCommand>((commands$) =>
			commands$.pipe(
				exhaustMap(({ owner }) => {
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
									status: 'online-only',
									onlineOnlyReason: 'unsupported',
								});
								return;
							}
							patchState(store, {
								status: 'ready',
								onlineOnlyReason: null,
								ownerEmail: result.snapshot.ownerEmail,
								cars: result.snapshot.cars,
							});
						}),
						catchError(() => {
							patchState(store, {
								status: 'online-only',
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
			prepare(command: PrepareOfflineWorkspaceCommand): void {
				prepare(command);
			},
			openOffline({ snapshot }: OpenOfflineWorkspaceCommand): void {
				patchState(store, {
					status: 'offline',
					onlineOnlyReason: null,
					ownerEmail: snapshot.ownerEmail,
					cars: snapshot.cars,
				});
			},
		};
	}),
);
