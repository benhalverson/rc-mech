import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { OwnerSessionStore } from './owner-session-store';

type WebAuthnOptions = {
	challenge: string;
	allowCredentials?: Array<{
		id: string;
		type: 'public-key';
		transports?: AuthenticatorTransport[];
	}>;
};

const base64UrlToBytes = (value: string): Uint8Array => {
	const normalized = value
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');
	return Uint8Array.from(window.atob(normalized), (character) =>
		character.charCodeAt(0),
	);
};

const bytesToBase64Url = (value: ArrayBuffer): string => {
	let binary = '';
	for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
	return window
		.btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
};

@Component({
	selector: 'app-sign-in',
	imports: [FormsModule],
	styleUrl: './garage-workspace.css',
	template: `
		<main class="access-shell" tabindex="-1">
			<section class="access-card" aria-labelledby="sign-in-title">
				<div class="eyebrow">RC Mech / Owner access</div>
				<h1 id="sign-in-title">Back to the<br />workbench.</h1>
				<p class="intro">Use the owner email to receive a one-time link, or continue with a passkey.</p>
				<form (ngSubmit)="requestMagicLink()">
					<label for="owner-email">Owner email</label>
					<input id="owner-email" name="email" type="email" autocomplete="email" required [ngModel]="email()" (ngModelChange)="email.set($event)" [disabled]="sending()" />
					<button class="button" type="submit" [disabled]="sending()">{{ sending() ? 'Sending link…' : 'Send magic link' }}</button>
				</form>
				<div class="divider"><span>or</span></div>
				<button class="button passkey-button" type="button" (click)="signInWithPasskey()" [disabled]="!webAuthnAvailable || working()">{{ working() ? 'Waiting for passkey…' : 'Sign in with a passkey' }}</button>
				@if (message()) { <p class="message" role="status">{{ message() }}</p> }
				@if (sent()) { <p class="hint">Open the link from this device. The link expires soon and can only be used once.</p> }
			</section>
		</main>
	`,
})
export class SignIn {
	private readonly http = inject(HttpClient);
	private readonly route = inject(ActivatedRoute);
	private readonly router = inject(Router);
	private readonly sessionStore = inject(OwnerSessionStore);
	protected readonly email = signal('');
	protected readonly sending = signal(false);
	protected readonly working = signal(false);
	protected readonly sent = signal(false);
	protected readonly message = signal('');
	protected readonly webAuthnAvailable =
		typeof window !== 'undefined' && 'PublicKeyCredential' in window;

	private get returnTo(): string {
		const value = this.route.snapshot.queryParamMap.get('returnTo');
		return value?.startsWith('/') && !value.startsWith('//')
			? value
			: '/garage';
	}

	protected requestMagicLink(): void {
		const email = this.email().trim();
		if (!email || this.sending()) return;
		this.sending.set(true);
		this.message.set('');
		const callbackURL = new URL(window.location.origin);
		callbackURL.searchParams.set('returnTo', this.returnTo);
		this.http
			.post(
				'/api/auth/sign-in/magic-link',
				{ email, callbackURL: callbackURL.toString() },
				{ withCredentials: true },
			)
			.subscribe({
				next: () => {
					this.sent.set(true);
					this.sending.set(false);
					this.message.set(
						'If that address is allowed, a sign-in link is on its way.',
					);
				},
				error: () => {
					this.sending.set(false);
					this.message.set(
						'That request could not be completed. Check the address and try again.',
					);
				},
			});
	}

	protected async signInWithPasskey(): Promise<void> {
		if (!this.webAuthnAvailable || this.working()) return;
		this.working.set(true);
		this.message.set('');
		try {
			const options = await firstValueFrom(
				this.http.get<WebAuthnOptions>(
					'/api/auth/passkey/generate-authenticate-options',
				),
			);
			const credential = await navigator.credentials.get({
				publicKey: {
					...options,
					challenge: base64UrlToBytes(options.challenge),
					allowCredentials: options.allowCredentials?.map((item) => ({
						...item,
						id: base64UrlToBytes(item.id),
					})),
				} as PublicKeyCredentialRequestOptions,
			});
			if (!(credential instanceof PublicKeyCredential))
				throw new Error('No passkey was returned by the browser.');
			const response = credential.response as AuthenticatorAssertionResponse;
			await firstValueFrom(
				this.http.post(
					'/api/auth/passkey/verify-authentication',
					{
						response: {
							id: credential.id,
							rawId: bytesToBase64Url(credential.rawId),
							response: {
								clientDataJSON: bytesToBase64Url(response.clientDataJSON),
								authenticatorData: bytesToBase64Url(response.authenticatorData),
								signature: bytesToBase64Url(response.signature),
								userHandle: response.userHandle
									? bytesToBase64Url(response.userHandle)
									: undefined,
							},
							type: credential.type,
							clientExtensionResults: credential.getClientExtensionResults(),
						},
					},
					{ withCredentials: true },
				),
			);
			this.sessionStore.refresh();
			await this.sessionStore.resolved();
			await this.router.navigateByUrl(this.returnTo);
		} catch (error) {
			this.message.set(
				error instanceof DOMException && error.name === 'NotAllowedError'
					? 'The passkey ceremony was cancelled or timed out.'
					: 'The passkey request could not be completed. Try again or use a magic link.',
			);
		} finally {
			this.working.set(false);
		}
	}
}
