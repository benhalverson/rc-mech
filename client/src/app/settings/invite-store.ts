import { computed, effect, inject } from '@angular/core';
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
	type Observable,
	of,
	tap,
	throwError,
} from 'rxjs';
import { OFFLINE_OPERATION_ID } from '../offline/offline-garage-storage';
import { ClipboardCapability } from './clipboard-capability';
import type { InviteCode, SettingsGatewayFailure } from './settings.models';
import { SettingsGateway } from './settings-gateway';
import { SettingsWorkspaceStore } from './settings-workspace-store';

export type InviteCommand =
	| { readonly kind: 'create'; readonly code: string }
	| { readonly kind: 'copy'; readonly code: string }
	| { readonly kind: 'revoke'; readonly code: InviteCode };

type InviteFailure =
	| SettingsGatewayFailure
	| { readonly kind: 'validation'; readonly message: string }
	| { readonly kind: 'copy-failed' };

export type InviteOutcome =
	| { readonly status: 'idle'; readonly operationId: null }
	| {
			readonly status: 'pending' | 'succeeded';
			readonly operationId: number;
			readonly command: InviteCommand;
	  }
	| {
			readonly status: 'failed';
			readonly operationId: number;
			readonly command: InviteCommand;
			readonly error: InviteFailure;
	  };

const idleOutcome = (): InviteOutcome => ({
	status: 'idle',
	operationId: null,
});

const requestFor = (
	gateway: SettingsGateway,
	clipboard: ClipboardCapability,
	command: InviteCommand,
): Observable<unknown> => {
	switch (command.kind) {
		case 'create':
			return gateway.createInvite(command.code);
		case 'copy':
			return clipboard
				.copy(command.code)
				.pipe(
					catchError(() =>
						throwError(() => ({ kind: 'copy-failed' as const })),
					),
				);
		case 'revoke':
			return gateway.revokeInvite(command.code);
	}
};

const failureMessage = (
	failure: InviteFailure,
	command: InviteCommand,
): string => {
	if (failure.kind === 'validation') return failure.message;
	if (failure.kind === 'copy-failed')
		return 'The invite code could not be copied.';
	if (failure.kind === 'http' && failure.message) return failure.message;
	return command.kind === 'create'
		? 'Invite code could not be created.'
		: 'Invite code could not be revoked.';
};

/**
 * Settings-route workflow for creating and revoking invite codes. Uses the shared
 * Settings workspace when prepared and the online gateway otherwise, projecting
 * canonical rejection and operation outcomes without treating pending local codes
 * as proof that the server has admitted them.
 */
export const InviteStore = signalStore(
	withState<{
		outcome: InviteOutcome;
		localRequestId: string | null;
		retainedLocally: boolean;
	}>({ outcome: idleOutcome(), localRequestId: null, retainedLocally: false }),
	withProps(() => ({
		gateway: inject(SettingsGateway),
		clipboard: inject(ClipboardCapability),
		nextOperationId: { value: 0 },
		workspace: inject(SettingsWorkspaceStore),
		nextLocalId: inject(OFFLINE_OPERATION_ID),
	})),
	withComputed((store) => ({
		codes: computed(
			() =>
				store.workspace.current()?.invites.codes ??
				(store.gateway.invites.hasValue()
					? store.gateway.invites.value().codes
					: []),
		),
		allowance: computed(
			() =>
				store.workspace.current()?.invites ??
				(store.gateway.invites.hasValue()
					? {
							allowance: store.gateway.invites.value().allowance,
							used: store.gateway.invites.value().used,
							remaining: store.gateway.invites.value().remaining,
						}
					: { allowance: 5, used: 0, remaining: 5 }),
		),
		loading: computed(
			() => !store.workspace.current() && store.gateway.invites.isLoading(),
		),
		readError: computed(() =>
			!store.workspace.current() && store.gateway.inviteFailure()
				? 'Invite codes could not be loaded.'
				: '',
		),
		action: computed(() => {
			const outcome = store.outcome();
			if (outcome.status !== 'pending') return null;
			return outcome.command.kind === 'revoke'
				? `revoke:${outcome.command.code.id}`
				: outcome.command.kind;
		}),
		message: computed(() => {
			const outcome = store.outcome();
			if (outcome.status !== 'succeeded') return '';
			if (store.retainedLocally()) return 'Saved on this device.';
			return outcome.command.kind === 'create'
				? 'Invite code created.'
				: outcome.command.kind === 'copy'
					? `Copied ${outcome.command.code}.`
					: 'Invite code revoked.';
		}),
		actionError: computed(() => {
			const failure = store.workspace
				.operations()
				.find(
					(operation) =>
						operation.command.type !== 'timezone' &&
						operation.status !== 'pending',
				);
			if (failure) return `Needs attention: ${failure.feedback}`;
			const outcome = store.outcome();
			return outcome.status === 'failed'
				? failureMessage(outcome.error, outcome.command)
				: '';
		}),
	})),
	withMethods((store) => {
		const mutate = rxMethod<InviteCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const operationId = ++store.nextOperationId.value;
					if (
						command.kind === 'create' &&
						!/^[A-Za-z0-9-]{6,32}$/.test(command.code)
					) {
						patchState(store, {
							outcome: {
								status: 'failed',
								operationId,
								command,
								error: {
									kind: 'validation',
									message:
										'Use 6–32 characters containing only letters, numbers, or hyphens.',
								},
							},
						});
						return of(null);
					}
					patchState(store, {
						retainedLocally: false,
						outcome: { status: 'pending', operationId, command },
					});
					if (command.kind !== 'copy' && store.workspace.available()) {
						const requestId = store.nextLocalId();
						patchState(store, { localRequestId: requestId });
						store.workspace.mutate({
							requestId,
							change:
								command.kind === 'create'
									? { type: 'invite-create', code: command.code }
									: { type: 'invite-revoke', inviteId: command.code.id },
						});
						return EMPTY;
					}
					return requestFor(store.gateway, store.clipboard, command).pipe(
						tap(() => {
							if (command.kind !== 'copy') store.gateway.invites.reload();
							patchState(store, {
								outcome: { status: 'succeeded', operationId, command },
							});
						}),
						catchError((error: InviteFailure) => {
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
				store.gateway.invites.reload();
			},
			clearOutcome(): void {
				patchState(store, { outcome: idleOutcome() });
			},
			create(code: string): void {
				if (
					store.outcome().status !== 'pending' &&
					(store.workspace.current() !== null ||
						store.gateway.invites.hasValue()) &&
					store.allowance().remaining > 0
				)
					mutate({ kind: 'create', code: code.trim() });
			},
			copy(code: string): void {
				if (store.outcome().status !== 'pending')
					mutate({ kind: 'copy', code });
			},
			revoke(code: InviteCode): void {
				if (store.outcome().status !== 'pending' && code.status === 'available')
					mutate({ kind: 'revoke', code });
			},
		};
	}),
	withHooks((store) => ({
		onInit() {
			effect(() => {
				const result = store.workspace.outcome();
				const current = store.outcome();
				if (
					result.requestId !== store.localRequestId() ||
					current.status !== 'pending'
				)
					return;
				if (result.status === 'succeeded')
					patchState(store, {
						localRequestId: null,
						retainedLocally: true,
						outcome: { ...current, status: 'succeeded' },
					});
				else if (result.status === 'failed')
					patchState(store, {
						localRequestId: null,
						outcome: {
							...current,
							status: 'failed',
							error: { kind: 'validation', message: result.message },
						},
					});
			});
		},
	})),
);
