import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import {
	catchError,
	defer,
	from,
	map,
	type Observable,
	throwError,
} from 'rxjs';
import type {
	PasskeyAssertion,
	PasskeyCapabilityFailure,
	PasskeyRequestOptions,
} from './authentication.models';

const isPasskeyCapabilityFailure = (
	error: unknown,
): error is PasskeyCapabilityFailure =>
	typeof error === 'object' &&
	error !== null &&
	'kind' in error &&
	['cancelled', 'missing-credential', 'unavailable'].includes(
		String(error.kind),
	);

export const passkeyCapabilityFailure = (
	error: unknown,
): PasskeyCapabilityFailure => {
	if (isPasskeyCapabilityFailure(error)) return error;
	return error instanceof DOMException && error.name === 'NotAllowedError'
		? { kind: 'cancelled' }
		: { kind: 'unavailable' };
};

@Injectable()
export class PasskeyCapability {
	private readonly view = inject(DOCUMENT).defaultView;
	readonly available = Boolean(this.view?.PublicKeyCredential);

	authenticate(options: PasskeyRequestOptions): Observable<PasskeyAssertion> {
		return defer(() => {
			const view = this.view;
			if (!view?.PublicKeyCredential)
				return throwError(
					() => ({ kind: 'unavailable' }) satisfies PasskeyCapabilityFailure,
				);
			const request = view.navigator.credentials.get({
				publicKey: {
					...options,
					challenge: this.base64UrlToBytes(options.challenge),
					allowCredentials: options.allowCredentials?.map((credential) => ({
						...credential,
						id: this.base64UrlToBytes(credential.id),
					})),
				} as PublicKeyCredentialRequestOptions,
			});
			return from(request).pipe(
				map((credential) => {
					if (!(credential instanceof view.PublicKeyCredential))
						throw {
							kind: 'missing-credential',
						} satisfies PasskeyCapabilityFailure;
					return this.assertion(credential);
				}),
			);
		}).pipe(
			catchError((error: unknown) =>
				throwError(() => passkeyCapabilityFailure(error)),
			),
		);
	}

	private base64UrlToBytes(value: string): Uint8Array {
		const normalized = value
			.replace(/-/g, '+')
			.replace(/_/g, '/')
			.padEnd(Math.ceil(value.length / 4) * 4, '=');
		return Uint8Array.from(this.view?.atob(normalized) ?? '', (character) =>
			character.charCodeAt(0),
		);
	}

	private bytesToBase64Url(value: ArrayBuffer): string {
		let binary = '';
		for (const byte of new Uint8Array(value))
			binary += String.fromCharCode(byte);
		return (this.view?.btoa(binary) ?? '')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	}

	private assertion(credential: PublicKeyCredential): PasskeyAssertion {
		const response = credential.response as AuthenticatorAssertionResponse;
		return {
			id: credential.id,
			rawId: this.bytesToBase64Url(credential.rawId),
			response: {
				clientDataJSON: this.bytesToBase64Url(response.clientDataJSON),
				authenticatorData: this.bytesToBase64Url(response.authenticatorData),
				signature: this.bytesToBase64Url(response.signature),
				userHandle: response.userHandle
					? this.bytesToBase64Url(response.userHandle)
					: undefined,
			},
			type: credential.type,
			clientExtensionResults: credential.getClientExtensionResults(),
		};
	}
}
