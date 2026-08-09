import { computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, EMPTY, exhaustMap, from, switchMap, tap } from 'rxjs';
import { OwnerSessionStore } from '../owner-session-store';
import { AuthenticationGateway } from './authentication-gateway';
import type {
	AuthenticatePasskeyCommand,
	AuthenticationFailure,
	AuthenticationGatewayFailure,
	AuthenticationOutcome,
	RegisterCommand,
	RequestMagicLinkCommand,
} from './authentication.models';
import { authenticationRouteContext } from './authentication-route';
import { PasskeyCapability } from './passkey-capability';

type AccessCommand = RequestMagicLinkCommand | RegisterCommand;

type AuthenticationState = {
	returnTo: string;
	message: string;
	sent: boolean;
	accessOutcome: AuthenticationOutcome;
	passkeyOutcome: AuthenticationOutcome;
};

const idleOutcome = (): AuthenticationOutcome => ({
	status: 'idle',
	operationId: null,
});

const isAuthenticationFailure = (
	error: unknown,
): error is AuthenticationFailure =>
	typeof error === 'object' &&
	error !== null &&
	'kind' in error &&
	[
		'rate-limited',
		'http',
		'unavailable',
		'invalid-response',
		'cancelled',
		'missing-credential',
	].includes(String(error.kind));

const authenticationFailure = (error: unknown): AuthenticationFailure =>
	isAuthenticationFailure(error) ? error : { kind: 'unavailable' };

const accessFailureMessage = (
	failure: AuthenticationGatewayFailure,
	operation: AccessCommand['operation'],
): string => {
	if (failure.kind === 'rate-limited')
		return 'Too many requests. Please wait a moment before trying again.';
	return operation === 'request-magic-link'
		? 'That request could not be completed. Check the address and try again.'
		: 'That request could not be completed. Check the details and try again.';
};

const passkeyFailureMessage = (failure: AuthenticationFailure): string =>
	failure.kind === 'cancelled'
		? 'The passkey ceremony was cancelled or timed out.'
		: 'The passkey request could not be completed. Try again or use a magic link.';

export const AuthenticationStore = signalStore(
	withState<AuthenticationState>(() => {
		const context = authenticationRouteContext(
			inject(ActivatedRoute).snapshot.queryParamMap,
		);
		return {
			returnTo: context.returnTo,
			message: context.message,
			sent: false,
			accessOutcome: idleOutcome(),
			passkeyOutcome: idleOutcome(),
		};
	}),
	withProps(() => ({
		gateway: inject(AuthenticationGateway),
		passkey: inject(PasskeyCapability),
		session: inject(OwnerSessionStore),
		router: inject(Router),
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => ({
		sending: computed(() => store.accessOutcome().status === 'pending'),
		working: computed(() => store.passkeyOutcome().status === 'pending'),
		webAuthnAvailable: computed(() => store.passkey.available),
	})),
	withMethods((store) => {
		const access = rxMethod<AccessCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						message: '',
						sent: false,
						accessOutcome: {
							status: 'pending',
							operation: command.operation,
							operationId,
						},
					});
					const request =
						command.operation === 'request-magic-link'
							? store.gateway.requestMagicLink(command, store.returnTo())
							: store.gateway.register(command, store.returnTo());
					return request.pipe(
						tap(() =>
							patchState(store, {
								message:
									command.operation === 'request-magic-link'
										? 'If that address is allowed, a sign-in link is on its way.'
										: 'If the email and invite code are valid, a registration link is on its way.',
								sent: true,
								accessOutcome: {
									status: 'succeeded',
									operation: command.operation,
									operationId,
								},
							}),
						),
						catchError((error: AuthenticationGatewayFailure) => {
							patchState(store, {
								message: accessFailureMessage(error, command.operation),
								accessOutcome: {
									status: 'failed',
									operation: command.operation,
									operationId,
									error,
								},
							});
							return EMPTY;
						}),
					);
				}),
			),
		);

		const authenticate = rxMethod<AuthenticatePasskeyCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					if (!store.passkey.available) return EMPTY;
					const operationId = ++store.nextOperationId.value;
					patchState(store, {
						message: '',
						passkeyOutcome: {
							status: 'pending',
							operation: command.operation,
							operationId,
						},
					});
					return store.gateway.authenticationOptions().pipe(
						switchMap((options) => store.passkey.authenticate(options)),
						switchMap((response) =>
							store.gateway.verifyAuthentication({ response }),
						),
						switchMap(() => from(store.session.refresh())),
						switchMap(() => from(store.router.navigateByUrl(store.returnTo()))),
						tap(() =>
							patchState(store, {
								passkeyOutcome: {
									status: 'succeeded',
									operation: command.operation,
									operationId,
								},
							}),
						),
						catchError((error: unknown) => {
							const failure = authenticationFailure(error);
							patchState(store, {
								message: passkeyFailureMessage(failure),
								passkeyOutcome: {
									status: 'failed',
									operation: command.operation,
									operationId,
									error: failure,
								},
							});
							return EMPTY;
						}),
					);
				}),
			),
		);

		return {
			requestMagicLink(command: RequestMagicLinkCommand): void {
				access(command);
			},
			register(command: RegisterCommand): void {
				access(command);
			},
			authenticateWithPasskey(command: AuthenticatePasskeyCommand): void {
				authenticate(command);
			},
			resetFeedback(): void {
				patchState(store, { message: '', sent: false });
			},
		};
	}),
);
