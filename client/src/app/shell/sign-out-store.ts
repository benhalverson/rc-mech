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
import { VoiceLegacyMigration } from '../voice/voice-legacy-migration';
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
	pendingRemoteSessionKey: string | null;
};

const initialState: SignOutState = {
	pendingRemoteOperationId: null,
	pendingRemoteSessionKey: null,
	outcome: { status: 'idle', operation: 'sign-out', operationId: null },
};

/**
 * Coordinates explicit sign-out as a local cleanup and server-session operation.
 * Checks pending durable work before destructive confirmation, clears the fenced
 * working copy, and retains deferred server cleanup when connectivity is absent.
 * The shell renders its outcome; storage owns the atomic cleanup boundary.
 */
export const SignOutStore = signalStore(
	{ providedIn: 'root' },
	withState(initialState),
	withProps(() => {
		const offlineCapabilities = inject(OfflineCapabilities);
		return {
			gateway: inject(SignOutGateway),
			legacy: offlineCapabilities.storageAvailable
				? inject(VoiceLegacyMigration)
				: null,
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
			patchState(store, {
				pendingRemoteOperationId: operationId,
				pendingRemoteSessionKey: store.session.sessionKey(),
			});
			store.session.signOutLocally();
			store.connectivity.scheduleRetry();
			return of({ success: true });
		};
		const revokeRemote = rxMethod<string>((operations) =>
			operations.pipe(
				exhaustMap((operationId) =>
					store.gateway
						.resumeSignOut(store.pendingRemoteSessionKey() as string)
						.pipe(
							switchMap(() =>
								from(
									(
										store.offlineStorage as OfflineGarageStorage
									).completeSignOut(operationId),
								),
							),
							tap(() =>
								patchState(store, {
									pendingRemoteOperationId: null,
									pendingRemoteSessionKey: null,
								}),
							),
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
					const cleanup = (async () => {
						if (!store.offlineStorage) return null;
						const legacy = store.legacy as VoiceLegacyMigration;
						const email =
							store.offline.ownerEmail() || store.session.ownerEmail();
						const legacyIds = await legacy.pendingForSignOut(email);
						if (legacyIds.length > 0 && command.discardPending !== true)
							return {
								kind: 'confirmation',
								count:
									legacyIds.length +
									(await store.offlineStorage.pendingWorkCount(legacyIds)),
							} as const;
						if (legacyIds.length > 0) await legacy.discardForSignOut(email);
						return store.offlineStorage.requestSignOut(
							store.session.sessionKey(),
							command.discardPending === true,
						);
					})();
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
			async restorePendingSignOut(): Promise<void> {
				try {
					const pending = await store.offlineStorage?.pendingSignOut();
					if (!pending) return;
					patchState(store, {
						pendingRemoteOperationId: pending.operationId,
						pendingRemoteSessionKey: pending.sessionKey,
					});
					revokeRemote(pending.operationId);
				} catch {
					store.connectivity.scheduleRetry();
				}
			},
			retryRemoteSignOut(): void {
				const operationId = store.pendingRemoteOperationId();
				if (operationId) revokeRemote(operationId);
				else void this.restorePendingSignOut();
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
