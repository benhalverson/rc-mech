import { Component, inject, signal } from '@angular/core';
import {
	disabled,
	FormField,
	form,
	required,
	validate,
} from '@angular/forms/signals';
import { AuthenticationStore } from './authentication-store';

@Component({
	selector: 'app-sign-in',
	imports: [FormField],
	templateUrl: './sign-in.html',
})
export class SignIn {
	protected readonly store = inject(AuthenticationStore);
	protected readonly registering = signal(false);
	protected readonly credentialsModel = signal({ email: '', inviteCode: '' });
	protected readonly credentialsForm = form(this.credentialsModel, (path) => {
		disabled(path.email, { when: () => this.store.sending() });
		disabled(path.inviteCode, { when: () => this.store.sending() });
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

	protected toggleRegistration(): void {
		this.registering.update((value) => !value);
		this.store.resetFeedback();
		this.credentialsForm.inviteCode().reset('');
	}

	protected submit(event: Event): void {
		event.preventDefault();
		if (this.registering()) this.register();
		else this.requestMagicLink();
	}

	private register(): void {
		this.credentialsForm.email().markAsTouched();
		this.credentialsForm.inviteCode().markAsTouched();
		const { email: rawEmail, inviteCode: rawInviteCode } =
			this.credentialsModel();
		if (
			this.credentialsForm.email().invalid() ||
			this.credentialsForm.inviteCode().invalid() ||
			this.store.sending()
		) {
			if (this.credentialsForm.email().invalid())
				this.credentialsForm.email().focusBoundControl();
			else this.credentialsForm.inviteCode().focusBoundControl();
			return;
		}
		this.store.register({
			operation: 'register',
			email: rawEmail.trim(),
			inviteCode: rawInviteCode.trim(),
		});
	}

	private requestMagicLink(): void {
		this.credentialsForm.email().markAsTouched();
		const email = this.credentialsModel().email.trim();
		if (this.credentialsForm.email().invalid() || this.store.sending()) {
			this.credentialsForm.email().focusBoundControl();
			return;
		}
		this.store.requestMagicLink({
			operation: 'request-magic-link',
			email,
		});
	}

	protected authenticateWithPasskey(): void {
		this.store.authenticateWithPasskey({
			operation: 'authenticate-passkey',
		});
	}
}
