import { DatePipe } from '@angular/common';
import { Component, inject, linkedSignal, signal } from '@angular/core';
import {
	FormField,
	form,
	maxLength,
	minLength,
	pattern,
	required,
	validate,
} from '@angular/forms/signals';
import { isValidTimezone, type Passkey } from './settings.models';
import { SettingsStore } from './settings-store';

@Component({
	selector: 'app-settings',
	imports: [DatePipe, FormField],
	templateUrl: './settings.html',
	styleUrl: '../garage-pages.css',
})
export class Settings {
	protected readonly store = inject(SettingsStore);
	protected readonly timezoneModel = linkedSignal(() => ({
		timezone: this.store.timezone(),
	}));
	protected readonly timezoneForm = form(this.timezoneModel, (path) => {
		required(path.timezone, { message: 'Enter a timezone.' });
		maxLength(path.timezone, 80, { message: 'Use 80 characters or fewer.' });
		validate(path.timezone, ({ value }) =>
			isValidTimezone(value().trim())
				? undefined
				: {
						kind: 'timezone',
						message: 'Use a valid IANA timezone, such as America/Los_Angeles.',
					},
		);
	});
	protected readonly inviteModel = signal({ code: '' });
	protected readonly inviteForm = form(this.inviteModel, (path) => {
		required(path.code, { message: 'Enter an invite code.' });
		minLength(path.code, 6, { message: 'Use at least 6 characters.' });
		maxLength(path.code, 32, { message: 'Use 32 characters or fewer.' });
		pattern(path.code, /^[A-Za-z0-9-]+$/, {
			message: 'Use only letters, numbers, or hyphens.',
		});
	});
	protected readonly passkeyModel = signal({ name: '' });
	protected readonly passkeyForm = form(this.passkeyModel, (path) => {
		required(path.name, { message: 'Name this passkey.' });
		maxLength(path.name, 80, { message: 'Use 80 characters or fewer.' });
	});
	protected readonly renameModel = signal({ name: '' });
	protected readonly renameForm = form(this.renameModel, (path) => {
		required(path.name, { message: 'Enter a passkey name.' });
		maxLength(path.name, 80, { message: 'Use 80 characters or fewer.' });
	});
	protected readonly editingPasskeyId = signal<string | null>(null);

	protected async saveTimezone(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		this.timezoneForm.timezone().markAsTouched();
		if (this.timezoneForm().invalid()) return;
		await this.store.saveTimezone(this.timezoneModel().timezone);
	}

	protected async createInviteCode(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		this.inviteForm.code().markAsTouched();
		if (this.inviteForm().invalid()) return;
		if (await this.store.createInviteCode(this.inviteModel().code))
			this.inviteModel.set({ code: '' });
	}

	protected async registerPasskey(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		this.passkeyForm.name().markAsTouched();
		if (this.passkeyForm().invalid()) return;
		if (await this.store.registerPasskey(this.passkeyModel().name))
			this.passkeyModel.set({ name: '' });
	}

	protected beginRename(passkey: Passkey): void {
		this.editingPasskeyId.set(passkey.id);
		this.renameModel.set({ name: passkey.name?.trim() || 'Passkey' });
	}

	protected cancelRename(): void {
		this.editingPasskeyId.set(null);
		this.renameModel.set({ name: '' });
	}

	protected async renamePasskey(
		event: SubmitEvent,
		passkey: Passkey,
	): Promise<void> {
		event.preventDefault();
		this.renameForm.name().markAsTouched();
		if (this.renameForm().invalid()) return;
		if (await this.store.renamePasskey(passkey, this.renameModel().name))
			this.cancelRename();
	}
}
