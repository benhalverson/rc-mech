import { computed, effect, inject, untracked } from '@angular/core';
import { Router } from '@angular/router';
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
import {
	catchError,
	EMPTY,
	exhaustMap,
	from,
	of,
	switchMap,
	tap,
	throwError,
} from 'rxjs';
import { OfflineCapabilities } from '../offline/offline-capabilities';
import { OfflineConnectivity } from '../offline/offline-connectivity';
import { OfflineGarageStorage } from '../offline/offline-garage-storage';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import { OwnerSessionStore } from '../owner-session-store';
import type { SignOutGatewayFailure } from './sign-out-contract';
import { SignOutGateway } from './sign-out-gateway';

export type SignOutCommand = {
	readonly operation: 'sign-out';
	readonly discardPending?: boolean;
};

export type SignOutOutcome =
	| { status: 'idle'; operation: 'sign-out'; operationId: null }
	| {
			status: 'confirmation';
			operation: 'sign-out';
			operationId: number;
			count: number;
	  }
	| { status: 'pending'; operation: 'sign-out'; operationId: number }
	| { status: 'succeeded'; operation: 'sign-out'; operationId: number }
	| {
			status: 'failed';
			operation: 'sign-out';
			operationId: number;
			error: SignOutGatewayFailure;
	  };

type SignOutState = {
	outcome: SignOutOutcome;
	pendingRemoteOperationId: string | null;
};

const initialState: SignOutState = {
	pendingRemoteOperationId: null,
	outcome: { status: 'idle', operation: 'sign-out', operationId: null },
};

export const SignOutStore = signalStore(
	{ providedIn: 'root' },
	withState(initialState),
	withProps(() => {
		const offlineCapabilities = inject(OfflineCapabilities);
		return {
			gateway: inject(SignOutGateway),
			connectivity: inject(OfflineConnectivity),
			offline: inject(OfflineWorkspaceStore),
			offlineStorage: offlineCapabilities.storageAvailable
				? inject(OfflineGarageStorage)
				: null,
			router: inject(Router),
			session: inject(OwnerSessionStore),
			nextOperationId: { value: 0 },
		};
	}),
	withComputed((store) => ({
		signingOut: computed(() => store.outcome().status === 'pending'),
		error: computed(() =>
			store.outcome().status === 'failed'
				? 'We could not sign you out. Try again.'
				: '',
		),
	})),
	withMethods((store) => {
		const clearOfflineSession = (operationId: string) => {
			store.offline.clear();
			store.session.signOutLocally();
			patchState(store, { pendingRemoteOperationId: operationId });
			store.connectivity.scheduleRetry();
			return of({ success: true });
		};
		const revokeRemote = rxMethod<string>((operations) =>
			operations.pipe(
				exhaustMap((operationId) =>
					store.gateway.signOut().pipe(
						switchMap(() =>
							from(
								(store.offlineStorage as OfflineGarageStorage).completeSignOut(
									operationId,
								),
							),
						),
						tap(() => patchState(store, { pendingRemoteOperationId: null })),
						catchError(() => {
							store.connectivity.scheduleRetry();
							return EMPTY;
						}),
					),
				),
			),
		);
		const signOut = rxMethod<SignOutCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						outcome: {
							status: 'pending',
							operation: 'sign-out',
							operationId,
						},
					});
					const cleanup = store.offlineStorage
						? store.offlineStorage.requestSignOut(
								store.session.sessionKey(),
								command.discardPending === true,
							)
						: Promise.resolve(null);
					return from(cleanup).pipe(
						catchError(() =>
							throwError(
								() =>
									({
										kind: 'unavailable',
									}) as const satisfies SignOutGatewayFailure,
							),
						),
						switchMap((cleanup) => {
							if (cleanup?.kind === 'confirmation') {
								patchState(store, {
									outcome: {
										status: 'confirmation',
										operation: 'sign-out',
										operationId,
										count: cleanup.count,
									},
								});
								return EMPTY;
							}
							const signOutOperationId = cleanup?.operationId;
							if (signOutOperationId && store.offline.networkUnavailable())
								return clearOfflineSession(signOutOperationId);
							return store.gateway.signOut().pipe(
								catchError((error: SignOutGatewayFailure) =>
									signOutOperationId &&
									(error.kind === 'unavailable' ||
										(error.kind === 'http' && error.status >= 500))
										? clearOfflineSession(signOutOperationId)
										: throwError(() => error),
								),
								switchMap((response) =>
									from(
										store.offlineStorage &&
											signOutOperationId &&
											!store.pendingRemoteOperationId()
											? store.offlineStorage.completeSignOut(signOutOperationId)
											: Promise.resolve(),
									).pipe(switchMap(() => of(response))),
								),
							);
						}),
						tap(() => {
							store.offline.clear();
							if (!store.pendingRemoteOperationId()) store.session.expire();
						}),
						switchMap(() =>
							from(store.router.navigate(['/sign-in'])).pipe(
								catchError(() => of(false)),
							),
						),
						tap(() =>
							patchState(store, {
								outcome: {
									status: 'succeeded',
									operation: 'sign-out',
									operationId,
								},
							}),
						),
						catchError((error: SignOutGatewayFailure) => {
							patchState(store, {
								outcome: {
									status: 'failed',
									operation: 'sign-out',
									operationId,
									error,
								},
							});
							return of(null);
						}),
					);
				}),
			),
		);
		return {
			retryRemoteSignOut(): void {
				const operationId = store.pendingRemoteOperationId();
				if (operationId) revokeRemote(operationId);
			},
			cancelSignOut(): void {
				if (store.outcome().status === 'confirmation')
					patchState(store, initialState);
			},
			signOut(command: SignOutCommand): void {
				signOut(command);
			},
		};
	}),
	withHooks((store) => ({
		onInit() {
			effect(() => {
				store.connectivity.retryHint();
				untracked(() => store.retryRemoteSignOut());
			});
		},
	})),
);
