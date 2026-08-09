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
import {
	catchError,
	exhaustMap,
	type Observable,
	of,
	switchMap,
	tap,
	throwError,
} from 'rxjs';
import { webAuthnError } from './passkey-credentials';
import { PasskeyRegistrationCapability } from './passkey-registration-capability';
import type { Passkey, SettingsGatewayFailure } from './settings.models';
import { SettingsGateway } from './settings-gateway';

export type PasskeyCommand =
	| { readonly kind: 'register'; readonly name: string }
	| {
			readonly kind: 'rename';
			readonly passkey: Passkey;
			readonly name: string;
	  }
	| { readonly kind: 'revoke'; readonly passkey: Passkey };

type PasskeyFailure =
	| SettingsGatewayFailure
	| { readonly kind: 'validation'; readonly message: string }
	| { readonly kind: 'capability'; readonly message: string };

export type PasskeyOutcome =
	| { readonly status: 'idle'; readonly operationId: null }
	| {
			readonly status: 'pending' | 'succeeded';
			readonly operationId: number;
			readonly command: PasskeyCommand;
	  }
	| {
			readonly status: 'failed';
			readonly operationId: number;
			readonly command: PasskeyCommand;
			readonly error: PasskeyFailure;
	  };

const idleOutcome = (): PasskeyOutcome => ({
	status: 'idle',
	operationId: null,
});

const requestFor = (
	gateway: SettingsGateway,
	registration: PasskeyRegistrationCapability,
	command: PasskeyCommand,
): Observable<unknown> => {
	if (command.kind === 'rename')
		return gateway.renamePasskey(command.passkey, command.name);
	if (command.kind === 'revoke') return gateway.revokePasskey(command.passkey);
	return gateway.registrationOptions(command.name).pipe(
		switchMap((options) =>
			registration.register(options).pipe(
				catchError((error: unknown) =>
					throwError(
						() =>
							({
								kind: 'capability',
								message: webAuthnError(error),
							}) satisfies PasskeyFailure,
					),
				),
			),
		),
		switchMap((response) => gateway.verifyRegistration(command.name, response)),
	);
};

const failureMessage = (failure: PasskeyFailure): string =>
	failure.kind === 'validation' || failure.kind === 'capability'
		? failure.message
		: failure.kind === 'http' && failure.message
			? failure.message
			: 'The passkey request could not be completed. Try again or use a magic link.';

export const PasskeyStore = signalStore(
	withState<{ outcome: PasskeyOutcome }>({ outcome: idleOutcome() }),
	withProps(() => ({
		gateway: inject(SettingsGateway),
		registration: inject(PasskeyRegistrationCapability),
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => ({
		passkeys: computed(() =>
			store.gateway.passkeys.hasValue() ? store.gateway.passkeys.value() : [],
		),
		loading: computed(() => store.gateway.passkeys.isLoading()),
		readError: computed(() =>
			store.gateway.passkeyFailure()
				? 'Passkeys could not be loaded. Try again.'
				: '',
		),
		webAuthnAvailable: computed(() => store.registration.available),
		action: computed(() => {
			const outcome = store.outcome();
			if (outcome.status !== 'pending') return null;
			return outcome.command.kind === 'register'
				? 'register'
				: `${outcome.command.kind}:${outcome.command.passkey.id}`;
		}),
		message: computed(() => {
			const outcome = store.outcome();
			if (outcome.status !== 'succeeded') return '';
			return outcome.command.kind === 'register'
				? 'Passkey added. Keep a second one registered for recovery from a lost device.'
				: outcome.command.kind === 'rename'
					? 'Passkey renamed.'
					: 'Passkey revoked. Magic-link recovery remains available.';
		}),
		actionError: computed(() => {
			const outcome = store.outcome();
			return outcome.status === 'failed' ? failureMessage(outcome.error) : '';
		}),
	})),
	withMethods((store) => {
		const mutate = rxMethod<PasskeyCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const operationId = ++store.nextOperationId.value;
					if (
						command.kind !== 'revoke' &&
						(!command.name || command.name.length > 80)
					) {
						patchState(store, {
							outcome: {
								status: 'failed',
								operationId,
								command,
								error: {
									kind: 'validation',
									message: 'Name this passkey with 80 characters or fewer.',
								},
							},
						});
						return of(null);
					}
					patchState(store, {
						outcome: { status: 'pending', operationId, command },
					});
					return requestFor(store.gateway, store.registration, command).pipe(
						tap(() => {
							store.gateway.passkeys.reload();
							patchState(store, {
								outcome: { status: 'succeeded', operationId, command },
							});
						}),
						catchError((error: PasskeyFailure) => {
							patchState(store, {
								outcome: { status: 'failed', operationId, command, error },
							});
							return of(null);
						}),
					);
				}),
			),
		);
		return {
			retry(): void {
				store.gateway.passkeys.reload();
			},
			register(name: string): void {
				if (
					store.registration.available &&
					store.outcome().status !== 'pending'
				)
					mutate({ kind: 'register', name: name.trim() });
			},
			rename(passkey: Passkey, name: string): void {
				if (store.outcome().status !== 'pending')
					mutate({ kind: 'rename', passkey, name: name.trim() });
			},
			revoke(passkey: Passkey): void {
				if (store.outcome().status !== 'pending')
					mutate({ kind: 'revoke', passkey });
			},
		};
	}),
);
