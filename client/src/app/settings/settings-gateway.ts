import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, throwError, type Observable } from 'rxjs';
import type { WebAuthnOptions } from './passkey-credentials';
import {
	acknowledgedMutationSchema,
	inviteCodesSchema,
	inviteMutationSchema,
	passkeyCollectionSchema,
	type InviteCode,
	type InviteCodesResponse,
	type Passkey,
	type SettingsGatewayFailure,
	webAuthnOptionsSchema,
} from './settings.models';

class InvalidSettingsResponse extends Error {}

const parse = <T>(
	result: { success: true; data: T } | { success: false },
): T => {
	if (!result.success) throw new InvalidSettingsResponse();
	return result.data;
};

export const settingsGatewayFailure = (
	error: unknown,
): SettingsGatewayFailure => {
	if (error instanceof HttpErrorResponse) {
		const message =
			typeof error.error === 'object' &&
			error.error !== null &&
			'error' in error.error &&
			typeof error.error.error === 'string'
				? error.error.error
				: undefined;
		return error.status === 0
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status, ...(message ? { message } : {}) };
	}
	return error instanceof InvalidSettingsResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

const mapFailure = (error: unknown): Observable<never> =>
	throwError(() => settingsGatewayFailure(error));

const parseInvites = (value: unknown): InviteCodesResponse =>
	parse(inviteCodesSchema.safeParse(value));

const parsePasskeys = (value: unknown): Passkey[] =>
	parse(passkeyCollectionSchema.safeParse(value));

@Injectable()
export class SettingsGateway {
	private readonly http = inject(HttpClient);

	readonly invites = httpResource<InviteCodesResponse>(
		() => ({ url: '/api/v1/invite-codes', withCredentials: true }),
		{ parse: parseInvites },
	);
	readonly passkeys = httpResource<Passkey[]>(
		() => ({
			url: '/api/auth/passkey/list-user-passkeys',
			withCredentials: true,
		}),
		{ parse: parsePasskeys },
	);

	createInvite(code: string): Observable<InviteCode> {
		return this.http
			.post<unknown>(
				'/api/v1/invite-codes',
				{ code },
				{ withCredentials: true },
			)
			.pipe(
				map((value) => parse(inviteMutationSchema.safeParse(value)).code),
				catchError(mapFailure),
			);
	}

	revokeInvite(code: InviteCode): Observable<void> {
		return this.http
			.post<unknown>(
				`/api/v1/invite-codes/${encodeURIComponent(code.id)}/revoke`,
				{},
				{ withCredentials: true },
			)
			.pipe(
				map((value) => {
					parse(acknowledgedMutationSchema.safeParse(value));
				}),
				catchError(mapFailure),
			);
	}

	registrationOptions(name: string): Observable<WebAuthnOptions> {
		return this.http
			.get<unknown>('/api/auth/passkey/generate-register-options', {
				params: { name },
				withCredentials: true,
			})
			.pipe(
				map((value) => parse(webAuthnOptionsSchema.safeParse(value))),
				catchError(mapFailure),
			);
	}

	verifyRegistration(
		name: string,
		response: Readonly<Record<string, unknown>>,
	): Observable<void> {
		return this.passkeyMutation('/api/auth/passkey/verify-registration', {
			response,
			name,
		});
	}

	renamePasskey(passkey: Passkey, name: string): Observable<void> {
		return this.passkeyMutation('/api/auth/passkey/update-passkey', {
			id: passkey.id,
			name,
		});
	}

	revokePasskey(passkey: Passkey): Observable<void> {
		return this.passkeyMutation('/api/auth/passkey/delete-passkey', {
			id: passkey.id,
		});
	}

	inviteFailure(): SettingsGatewayFailure | null {
		const error = this.invites.error();
		return error ? settingsGatewayFailure(error) : null;
	}

	passkeyFailure(): SettingsGatewayFailure | null {
		const error = this.passkeys.error();
		return error ? settingsGatewayFailure(error) : null;
	}

	private passkeyMutation(
		url: string,
		body: Readonly<Record<string, unknown>>,
	): Observable<void> {
		return this.http.post<unknown>(url, body, { withCredentials: true }).pipe(
			map((value) => {
				parse(acknowledgedMutationSchema.safeParse(value));
			}),
			catchError(mapFailure),
		);
	}
}
