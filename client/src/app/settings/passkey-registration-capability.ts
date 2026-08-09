import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { defer, from, map, type Observable, throwError } from 'rxjs';
import {
	registrationOptions,
	registrationResponse,
	type WebAuthnOptions,
} from './passkey-credentials';

@Injectable()
export class PasskeyRegistrationCapability {
	private readonly view = inject(DOCUMENT).defaultView;

	readonly available = Boolean(
		this.view?.PublicKeyCredential &&
			(this.view.isSecureContext ||
				this.view.location.hostname === 'localhost' ||
				this.view.location.hostname === '127.0.0.1'),
	);

	register(options: WebAuthnOptions): Observable<Record<string, unknown>> {
		return defer(() => {
			const view = this.view;
			if (!view?.PublicKeyCredential || !this.available)
				return throwError(() => new Error('Passkeys unavailable'));
			return from(
				view.navigator.credentials.create({
					publicKey: registrationOptions(options, view),
				}),
			).pipe(
				map((credential) => {
					if (!(credential instanceof view.PublicKeyCredential))
						throw new Error('No passkey was returned by the browser.');
					return registrationResponse(credential, view);
				}),
			);
		});
	}
}
