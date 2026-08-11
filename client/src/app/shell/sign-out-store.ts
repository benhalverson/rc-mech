import { computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
	catchError,
	exhaustMap,
	from,
	of,
	switchMap,
	tap,
	throwError,
} from 'rxjs';
import { OfflineCapabilities } from '../offline/offline-capabilities';
import { OfflineGarageStorage } from '../offline/offline-garage-storage';
import { OwnerSessionStore } from '../owner-session-store';
import type { SignOutGatewayFailure } from './sign-out-contract';
import { SignOutGateway } from './sign-out-gateway';

export type SignOutCommand = { readonly operation: 'sign-out' };

export type SignOutOutcome =
	| { status: 'idle'; operation: 'sign-out'; operationId: null }
	| { status: 'pending'; operation: 'sign-out'; operationId: number }
	| { status: 'succeeded'; operation: 'sign-out'; operationId: number }
	| {
			status: 'failed';
			operation: 'sign-out';
			operationId: number;
			error: SignOutGatewayFailure;
	  };

type SignOutState = { outcome: SignOutOutcome };

const initialState: SignOutState = {
	outcome: { status: 'idle', operation: 'sign-out', operationId: null },
};

export const SignOutStore = signalStore(
	{ providedIn: 'root' },
	withState(initialState),
	withProps(() => {
		const offlineCapabilities = inject(OfflineCapabilities);
		return {
			gateway: inject(SignOutGateway),
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
		const signOut = rxMethod<SignOutCommand>((commands$) =>
			commands$.pipe(
				exhaustMap(() => {
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						outcome: {
							status: 'pending',
							operation: 'sign-out',
							operationId,
						},
					});
					const cleanup = store.offlineStorage
						? store.offlineStorage.deactivate(store.session.sessionKey())
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
						switchMap((signOutOperationId) =>
							store.gateway
								.signOut()
								.pipe(
									switchMap((response) =>
										from(
											store.offlineStorage && signOutOperationId
												? store.offlineStorage.completeSignOut(
														signOutOperationId,
													)
												: Promise.resolve(),
										).pipe(switchMap(() => of(response))),
									),
								),
						),
						tap(() => store.session.expire()),
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
			signOut(command: SignOutCommand): void {
				signOut(command);
			},
		};
	}),
);
