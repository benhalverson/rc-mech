import { DatePipe } from '@angular/common';
import {
	afterNextRender,
	Component,
	ElementRef,
	inject,
	Injector,
	linkedSignal,
	signal,
} from '@angular/core';
import {
	FormField,
	form,
	maxLength,
	minLength,
	pattern,
	required,
	validate,
} from '@angular/forms/signals';
import {
	LucideCheck,
	LucideClipboardCopy,
	LucideKeyRound,
	LucidePencil,
	LucidePlus,
	LucideRefreshCw,
	LucideSave,
	LucideTrash2,
	LucideTriangleAlert,
	LucideX,
} from '@lucide/angular';
import { AppearanceSelector } from './appearance-selector';
import { isValidTimezone, type Passkey } from './settings.models';
import { SettingsStore } from './settings-store';
import { TimezoneStore } from './timezone-store';

@Component({
	selector: 'app-settings',
	host: { class: 'block min-w-0' },
	imports: [
		AppearanceSelector,
		DatePipe,
		FormField,
		LucideCheck,
		LucideClipboardCopy,
		LucideKeyRound,
		LucidePencil,
		LucidePlus,
		LucideRefreshCw,
		LucideSave,
		LucideTrash2,
		LucideTriangleAlert,
		LucideX,
	],
	templateUrl: './settings.html',
})
export class Settings {
	private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
	private readonly injector = inject(Injector);
	protected readonly store = inject(SettingsStore);
	protected readonly timezoneStore = inject(TimezoneStore);
	protected readonly timezoneModel = linkedSignal(() => ({
		timezone: this.timezoneStore.timezone(),
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

	protected saveTimezone(event: SubmitEvent): void {
		event.preventDefault();
		this.timezoneForm.timezone().markAsTouched();
		if (this.timezoneForm().invalid()) {
			this.focusField('#garage-timezone');
			return;
		}
		this.timezoneStore.saveTimezone({
			timezone: this.timezoneModel().timezone,
		});
	}

	protected async createInviteCode(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		this.inviteForm.code().markAsTouched();
		if (this.inviteForm().invalid()) {
			this.focusField('#new-invite-code');
			return;
		}
		if (await this.store.createInviteCode(this.inviteModel().code))
			this.inviteForm().reset({ code: '' });
	}

	protected async registerPasskey(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		this.passkeyForm.name().markAsTouched();
		if (this.passkeyForm().invalid()) {
			this.focusField('#passkey-name');
			return;
		}
		if (await this.store.registerPasskey(this.passkeyModel().name))
			this.passkeyForm().reset({ name: '' });
	}

	protected beginRename(passkey: Passkey): void {
		this.renameForm().reset({ name: passkey.name?.trim() || 'Passkey' });
		this.editingPasskeyId.set(passkey.id);
		afterNextRender(() => this.focusField(`#rename-${passkey.id}`), {
			injector: this.injector,
		});
	}

	protected cancelRename(passkey: Passkey): void {
		this.editingPasskeyId.set(null);
		this.renameForm().reset({ name: '' });
		afterNextRender(() => this.focusField(`#rename-launcher-${passkey.id}`), {
			injector: this.injector,
		});
	}

	protected async renamePasskey(
		event: SubmitEvent,
		passkey: Passkey,
	): Promise<void> {
		event.preventDefault();
		this.renameForm.name().markAsTouched();
		if (this.renameForm().invalid()) {
			this.focusField(`#rename-${passkey.id}`);
			return;
		}
		if (await this.store.renamePasskey(passkey, this.renameModel().name))
			this.cancelRename(passkey);
	}

	private focusField(selector: string): void {
		this.element.nativeElement.querySelector<HTMLElement>(selector)?.focus();
	}
}
