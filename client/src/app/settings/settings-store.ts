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
	defaultTimezone,
	type InviteCode,
	type InviteCodesResponse,
	isValidTimezone,
	type Passkey,
	type TimezoneResponse,
} from './settings.models';

type SettingsState = {
	timezoneSaving: boolean;
	timezoneMessage: string;
	timezoneMutationError: string;
	inviteAction: string | null;
	inviteMessage: string;
	inviteMutationError: string;
	passkeyAction: string | null;
	passkeyMessage: string;
};

const initialState: SettingsState = {
	timezoneSaving: false,
	timezoneMessage: '',
	timezoneMutationError: '',
	inviteAction: null,
	inviteMessage: '',
	inviteMutationError: '',
	passkeyAction: null,
	passkeyMessage: '',
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
		timezoneResource: httpResource<TimezoneResponse>(() => ({
			url: '/api/v1/preferences/timezone',
			withCredentials: true,
		})),
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
		timezone: computed(() => {
			const value = store.timezoneResource.hasValue()
				? store.timezoneResource.value().timezone
				: undefined;
			return value && isValidTimezone(value) ? value : defaultTimezone();
		}),
		timezoneLoading: computed(() => store.timezoneResource.isLoading()),
		timezoneError: computed(() =>
			store.timezoneMutationError()
				? store.timezoneMutationError()
				: store.timezoneResource.error()
					? 'The timezone setting could not be loaded. Dates are shown in your browser timezone.'
					: '',
		),
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
		webAuthnAvailable: computed(
			() =>
				typeof navigator !== 'undefined' &&
				'credentials' in navigator &&
				typeof PublicKeyCredential !== 'undefined' &&
				(typeof window === 'undefined' ||
					window.isSecureContext ||
					window.location.hostname === 'localhost' ||
					window.location.hostname === '127.0.0.1'),
		),
	})),
	withMethods((store) => ({
		retryTimezone(): void {
			patchState(store, { timezoneMutationError: '' });
			store.timezoneResource.reload();
		},
		async saveTimezone(value: string): Promise<boolean> {
			const timezone = value.trim();
			if (!isValidTimezone(timezone)) {
				patchState(store, {
					timezoneMutationError:
						'Use a valid IANA timezone, such as America/Los_Angeles.',
				});
				return false;
			}
			patchState(store, {
				timezoneSaving: true,
				timezoneMessage: '',
				timezoneMutationError: '',
			});
			try {
				await firstValueFrom(
					store.http.patch<TimezoneResponse>(
						'/api/v1/preferences/timezone',
						{ timezone },
						{ withCredentials: true },
					),
				);
				store.timezoneResource.reload();
				patchState(store, {
					timezoneSaving: false,
					timezoneMessage: `Dates will now use ${timezone}.`,
				});
				return true;
			} catch (error) {
				patchState(store, {
					timezoneSaving: false,
					timezoneMutationError: apiMessage(
						error,
						'The timezone could not be saved. Check the name and try again.',
					),
				});
				return false;
			}
		},
		retryInvites(): void {
			patchState(store, { inviteMutationError: '' });
			store.inviteResource.reload();
		},
		async createInviteCode(value: string): Promise<boolean> {
			const code = value.trim();
			if (!code || store.inviteAction()) return false;
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
			store.passkeyResource.reload();
		},
		async registerPasskey(nameValue: string): Promise<boolean> {
			const name = nameValue.trim();
			if (!store.webAuthnAvailable() || !name || store.passkeyAction())
				return false;
			patchState(store, { passkeyAction: 'register', passkeyMessage: '' });
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
				});
				return true;
			} catch (error) {
				patchState(store, {
					passkeyAction: null,
					passkeyMessage: webAuthnError(error),
				});
				return false;
			}
		},
		async renamePasskey(passkey: Passkey, nameValue: string): Promise<boolean> {
			const name = nameValue.trim();
			if (!name || store.passkeyAction()) return false;
			patchState(store, {
				passkeyAction: `rename:${passkey.id}`,
				passkeyMessage: '',
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
				});
				return true;
			} catch (error) {
				patchState(store, {
					passkeyAction: null,
					passkeyMessage: webAuthnError(error),
				});
				return false;
			}
		},
		async revokePasskey(passkey: Passkey): Promise<void> {
			if (store.passkeyAction()) return;
			patchState(store, {
				passkeyAction: `revoke:${passkey.id}`,
				passkeyMessage: '',
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
				});
			} catch (error) {
				patchState(store, {
					passkeyAction: null,
					passkeyMessage: webAuthnError(error),
				});
			}
		},
	})),
);
