import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormField, form, required, validate } from '@angular/forms/signals';
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
	imports: [FormField],
	styleUrl: './garage-pages.css',
	template: `
		<main class="access-shell" tabindex="-1">
			<section class="access-card" aria-labelledby="sign-in-title">
				<div class="eyebrow">RC Mech / Owner access</div>
				<h1 id="sign-in-title" data-route-focus tabindex="-1">Back to the<br />workbench.</h1>
				<p class="intro">{{ registering() ? 'Use an invite code to start your own private garage.' : 'Use your email to receive a one-time link, or continue with a passkey.' }}</p>
				<form (submit)="submit($event)" novalidate>
					<label for="owner-email">Email address</label>
					<input id="owner-email" type="email" autocomplete="email" [formField]="credentialsForm.email" [attr.aria-describedby]="credentialsForm.email().touched() && credentialsForm.email().invalid() ? 'email-validation' : null" />
					@if (credentialsForm.email().touched() && credentialsForm.email().invalid()) { <p id="email-validation" class="hint" role="alert">{{ credentialsForm.email().errors()[0]?.message }}</p> }
					@if (registering()) {
						<label for="invite-code">Invite code</label>
						<input id="invite-code" autocomplete="off" [formField]="credentialsForm.inviteCode" [attr.aria-describedby]="credentialsForm.inviteCode().touched() && credentialsForm.inviteCode().invalid() ? 'invite-code-validation' : null" />
						@if (credentialsForm.inviteCode().touched() && credentialsForm.inviteCode().invalid()) { <p id="invite-code-validation" class="hint" role="alert">{{ credentialsForm.inviteCode().errors()[0]?.message }}</p> }
					}
					<button class="button" type="submit" [disabled]="sending()">{{ sending() ? 'Sending link…' : registering() ? 'Start registration' : 'Send magic link' }}</button>
				</form>
				@if (!registering()) {
					<div class="divider"><span>or</span></div>
					<button class="button passkey-button" type="button" (click)="signInWithPasskey()" [disabled]="!webAuthnAvailable || working()">{{ working() ? 'Waiting for passkey…' : 'Sign in with a passkey' }}</button>
				}
				<button class="text-button" type="button" (click)="toggleRegistration()" [disabled]="sending()">{{ registering() ? 'Already have an account? Sign in' : 'Have an invite code? Register' }}</button>
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
	protected readonly credentialsModel = signal({ email: '', inviteCode: '' });
	protected readonly credentialsForm = form(this.credentialsModel, (path) => {
		required(path.email, { message: 'Enter your email address.' });
		validate(path.email, ({ value }) =>
			/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value().trim())
				? undefined
				: { kind: 'email', message: 'Enter a valid email address.' },
		);
		required(path.inviteCode, { message: 'Enter an invite code.' });
		validate(path.inviteCode, ({ value }) => {
			const code = value().trim();
			if (code.length < 6)
				return { kind: 'minLength', message: 'Use at least 6 characters.' };
			if (code.length > 32)
				return { kind: 'maxLength', message: 'Use 32 characters or fewer.' };
			return /^[A-Za-z0-9-]+$/.test(code)
				? undefined
				: {
						kind: 'pattern',
						message: 'Use only letters, numbers, or hyphens.',
					};
		});
	});
	protected readonly registering = signal(false);
	protected readonly sending = signal(false);
	protected readonly working = signal(false);
	protected readonly sent = signal(false);
	protected readonly message = signal(this.initialMessage());
	protected readonly webAuthnAvailable =
		typeof window !== 'undefined' && 'PublicKeyCredential' in window;

	private get returnTo(): string {
		const value = this.route.snapshot.queryParamMap.get('returnTo');
		return value?.startsWith('/') && !value.startsWith('//')
			? value
			: '/garage';
	}

	private initialMessage(): string {
		if (this.route.snapshot.queryParamMap.get('reason') === 'session-expired')
			return 'Your garage session has expired. Sign in again to continue.';
		const errorParameters = [
			'error',
			'error_description',
			'error_code',
			'errorCode',
		];
		return errorParameters.some((parameter) =>
			this.route.snapshot.queryParamMap.has(parameter),
		)
			? 'That recovery link could not be used. Request a new magic link and try again.'
			: '';
	}

	protected toggleRegistration(): void {
		this.registering.update((value) => !value);
		this.message.set('');
		this.sent.set(false);
		this.credentialsForm.inviteCode().reset('');
	}

	protected submit(event: Event): void {
		event.preventDefault();
		if (this.registering()) this.register();
		else this.requestMagicLink();
	}

	protected register(): void {
		this.credentialsForm.email().markAsTouched();
		this.credentialsForm.inviteCode().markAsTouched();
		const { email: rawEmail, inviteCode: rawInviteCode } =
			this.credentialsModel();
		const email = rawEmail.trim();
		const inviteCode = rawInviteCode.trim();
		if (
			this.credentialsForm.email().invalid() ||
			this.credentialsForm.inviteCode().invalid() ||
			this.sending()
		) {
			if (this.credentialsForm.email().invalid())
				this.credentialsForm.email().focusBoundControl();
			else this.credentialsForm.inviteCode().focusBoundControl();
			return;
		}
		this.sending.set(true);
		this.message.set('');
		this.http
			.post(
				'/api/auth/register',
				{ email, inviteCode, callbackURL: this.returnTo },
				{ withCredentials: true },
			)
			.subscribe({
				next: () => {
					this.sent.set(true);
					this.sending.set(false);
					this.message.set(
						'If the email and invite code are valid, a registration link is on its way.',
					);
				},
				error: (error: { status?: number }) => {
					this.sending.set(false);
					this.message.set(
						error.status === 429
							? 'Too many requests. Please wait a moment before trying again.'
							: 'That request could not be completed. Check the details and try again.',
					);
				},
			});
	}

	protected requestMagicLink(): void {
		this.credentialsForm.email().markAsTouched();
		const email = this.credentialsModel().email.trim();
		if (this.credentialsForm.email().invalid() || this.sending()) {
			this.credentialsForm.email().focusBoundControl();
			return;
		}
		this.sending.set(true);
		this.message.set('');
		const callbackURL = new URL(this.returnTo, window.location.origin);
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
				error: (error: { status?: number }) => {
					this.sending.set(false);
					this.message.set(
						error.status === 429
							? 'Too many requests. Please wait a moment before trying again.'
							: 'That request could not be completed. Check the address and try again.',
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
			await this.sessionStore.refresh();
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
