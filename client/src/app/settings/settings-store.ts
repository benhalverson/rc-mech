import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { computed, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import {
	registrationOptions,
	registrationResponse,
	type WebAuthnOptions,
	webAuthnError,
} from './passkey-credentials';
import {
	type InviteCode,
	type InviteCodesResponse,
	type Passkey,
} from './settings.models';

type SettingsState = {
	inviteAction: string | null;
	inviteMessage: string;
	inviteMutationError: string;
	passkeyAction: string | null;
	passkeyMessage: string;
	passkeyMutationError: string;
};

const initialState: SettingsState = {
	inviteAction: null,
	inviteMessage: '',
	inviteMutationError: '',
	passkeyAction: null,
	passkeyMessage: '',
	passkeyMutationError: '',
};

const apiMessage = (error: unknown, fallback: string): string => {
	if (
		error instanceof HttpErrorResponse &&
		typeof error.error === 'object' &&
		error.error !== null &&
		'error' in error.error &&
		typeof error.error.error === 'string'
	)
		return error.error.error;
	return fallback;
};

export const SettingsStore = signalStore(
	withState(initialState),
	withProps(() => ({
		http: inject(HttpClient),
		inviteResource: httpResource<InviteCodesResponse>(() => ({
			url: '/api/v1/invite-codes',
			withCredentials: true,
		})),
		passkeyResource: httpResource<Passkey[]>(() => ({
			url: '/api/auth/passkey/list-user-passkeys',
			withCredentials: true,
		})),
	})),
	withComputed((store) => ({
		inviteCodes: computed(() =>
			store.inviteResource.hasValue() ? store.inviteResource.value().codes : [],
		),
		inviteAllowance: computed(() => ({
			allowance: store.inviteResource.hasValue()
				? store.inviteResource.value().allowance
				: 5,
			used: store.inviteResource.hasValue()
				? store.inviteResource.value().used
				: 0,
			remaining: store.inviteResource.hasValue()
				? store.inviteResource.value().remaining
				: 5,
		})),
		inviteLoading: computed(() => store.inviteResource.isLoading()),
		inviteError: computed(() =>
			store.inviteResource.error() ? 'Invite codes could not be loaded.' : '',
		),
		inviteActionError: computed(() => store.inviteMutationError()),
		passkeys: computed(() =>
			store.passkeyResource.hasValue() ? store.passkeyResource.value() : [],
		),
		passkeysLoading: computed(() => store.passkeyResource.isLoading()),
		passkeyError: computed(() =>
			store.passkeyResource.error()
				? 'Passkeys could not be loaded. Try again.'
				: '',
		),
		passkeyActionError: computed(() => store.passkeyMutationError()),
		webAuthnAvailable: computed(
			() =>
				typeof window !== 'undefined' &&
				typeof navigator !== 'undefined' &&
				'credentials' in navigator &&
				typeof PublicKeyCredential !== 'undefined' &&
				(window.isSecureContext ||
					window.location.hostname === 'localhost' ||
					window.location.hostname === '127.0.0.1'),
		),
	})),
	withMethods((store) => ({
		retryInvites(): void {
			patchState(store, { inviteMutationError: '' });
			store.inviteResource.reload();
		},
		async createInviteCode(value: string): Promise<boolean> {
			const code = value.trim();
			if (!/^[A-Za-z0-9-]{6,32}$/.test(code)) {
				patchState(store, {
					inviteMessage: '',
					inviteMutationError:
						'Use 6–32 characters containing only letters, numbers, or hyphens.',
				});
				return false;
			}
			if (
				store.inviteAction() ||
				!store.inviteResource.hasValue() ||
				store.inviteResource.value().remaining === 0
			)
				return false;
			patchState(store, {
				inviteAction: 'create',
				inviteMessage: '',
				inviteMutationError: '',
			});
			try {
				await firstValueFrom(
					store.http.post<{ code: InviteCode }>(
						'/api/v1/invite-codes',
						{ code },
						{ withCredentials: true },
					),
				);
				store.inviteResource.reload();
				patchState(store, {
					inviteAction: null,
					inviteMessage: 'Invite code created.',
				});
				return true;
			} catch (error) {
				patchState(store, {
					inviteAction: null,
					inviteMutationError: apiMessage(
						error,
						'Invite code could not be created.',
					),
				});
				return false;
			}
		},
		async copyInviteCode(code: string): Promise<void> {
			try {
				await navigator.clipboard.writeText(code);
				patchState(store, {
					inviteMessage: `Copied ${code}.`,
					inviteMutationError: '',
				});
			} catch {
				patchState(store, {
					inviteMessage: '',
					inviteMutationError: 'The invite code could not be copied.',
				});
			}
		},
		async revokeInviteCode(code: InviteCode): Promise<void> {
			if (store.inviteAction() || code.status !== 'available') return;
			patchState(store, {
				inviteAction: `revoke:${code.id}`,
				inviteMessage: '',
				inviteMutationError: '',
			});
			try {
				await firstValueFrom(
					store.http.post(
						`/api/v1/invite-codes/${code.id}/revoke`,
						{},
						{ withCredentials: true },
					),
				);
				store.inviteResource.reload();
				patchState(store, {
					inviteAction: null,
					inviteMessage: 'Invite code revoked.',
				});
			} catch (error) {
				patchState(store, {
					inviteAction: null,
					inviteMutationError: apiMessage(
						error,
						'Invite code could not be revoked.',
					),
				});
			}
		},
		retryPasskeys(): void {
			patchState(store, { passkeyMutationError: '' });
			store.passkeyResource.reload();
		},
		async registerPasskey(nameValue: string): Promise<boolean> {
			const name = nameValue.trim();
			if (!name || name.length > 80) {
				patchState(store, {
					passkeyMessage: '',
					passkeyMutationError:
						'Name this passkey with 80 characters or fewer.',
				});
				return false;
			}
			if (!store.webAuthnAvailable() || store.passkeyAction()) return false;
			patchState(store, {
				passkeyAction: 'register',
				passkeyMessage: '',
				passkeyMutationError: '',
			});
			try {
				const options = await firstValueFrom(
					store.http.get<WebAuthnOptions>(
						'/api/auth/passkey/generate-register-options',
						{ params: { name }, withCredentials: true },
					),
				);
				const credential = await navigator.credentials.create({
					publicKey: registrationOptions(options),
				});
				if (
					!credential ||
					typeof credential !== 'object' ||
					!('response' in credential)
				)
					throw new Error('No passkey was returned by the browser.');
				await firstValueFrom(
					store.http.post(
						'/api/auth/passkey/verify-registration',
						{
							response: registrationResponse(credential as PublicKeyCredential),
							name,
						},
						{ withCredentials: true },
					),
				);
				store.passkeyResource.reload();
				patchState(store, {
					passkeyAction: null,
					passkeyMessage:
						'Passkey added. Keep a second one registered for recovery from a lost device.',
					passkeyMutationError: '',
				});
				return true;
			} catch (error) {
				patchState(store, {
					passkeyAction: null,
					passkeyMessage: '',
					passkeyMutationError: webAuthnError(error),
				});
				return false;
			}
		},
		async renamePasskey(passkey: Passkey, nameValue: string): Promise<boolean> {
			const name = nameValue.trim();
			if (!name || name.length > 80) {
				patchState(store, {
					passkeyMessage: '',
					passkeyMutationError:
						'Name this passkey with 80 characters or fewer.',
				});
				return false;
			}
			if (store.passkeyAction()) return false;
			patchState(store, {
				passkeyAction: `rename:${passkey.id}`,
				passkeyMessage: '',
				passkeyMutationError: '',
			});
			try {
				await firstValueFrom(
					store.http.post(
						'/api/auth/passkey/update-passkey',
						{ id: passkey.id, name },
						{ withCredentials: true },
					),
				);
				store.passkeyResource.reload();
				patchState(store, {
					passkeyAction: null,
					passkeyMessage: 'Passkey renamed.',
					passkeyMutationError: '',
				});
				return true;
			} catch (error) {
				patchState(store, {
					passkeyAction: null,
					passkeyMessage: '',
					passkeyMutationError: webAuthnError(error),
				});
				return false;
			}
		},
		async revokePasskey(passkey: Passkey): Promise<void> {
			if (store.passkeyAction()) return;
			patchState(store, {
				passkeyAction: `revoke:${passkey.id}`,
				passkeyMessage: '',
				passkeyMutationError: '',
			});
			try {
				await firstValueFrom(
					store.http.post(
						'/api/auth/passkey/delete-passkey',
						{ id: passkey.id },
						{ withCredentials: true },
					),
				);
				store.passkeyResource.reload();
				patchState(store, {
					passkeyAction: null,
					passkeyMessage:
						'Passkey revoked. Magic-link recovery remains available.',
					passkeyMutationError: '',
				});
			} catch (error) {
				patchState(store, {
					passkeyAction: null,
					passkeyMessage: '',
					passkeyMutationError: webAuthnError(error),
				});
			}
		},
	})),
);
