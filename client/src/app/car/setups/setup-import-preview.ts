import {
	Component,
	computed,
	effect,
	inject,
	input,
	signal,
} from '@angular/core';
import { FormField, form, required, validate } from '@angular/forms/signals';
import { LucideFileInput, LucideTriangleAlert } from '@lucide/angular';
import { isSupportedSoDialedUrl } from './setup-import-rules';
import type { SetupGatewayFailure } from './setup-snapshot';
import { SetupSnapshotStore } from './setup-snapshot-store';

const previewFailureMessage = (error: SetupGatewayFailure): string => {
	if (error.kind === 'http' && error.status === 401)
		return 'Your garage session has expired. Sign in again to continue.';
	return error.kind === 'rejected'
		? error.message
		: 'That source could not be read. Check the link and try again.';
};

@Component({
	selector: 'app-setup-import-preview',
	imports: [FormField, LucideFileInput, LucideTriangleAlert],
	templateUrl: './setup-import-preview.html',
})
export class SetupImportPreview {
	private readonly store = inject(SetupSnapshotStore);
	private handledOutcomeId = this.store.outcome().operationId;
	readonly carId = input('');
	readonly archived = input(false);
	protected readonly importUrlModel = signal({ url: '' });
	protected readonly importUrlForm = form(this.importUrlModel, (path) => {
		required(path.url, { message: 'Paste a So Dialed setup URL.' });
		validate(path.url, ({ value }) => {
			const url = value().trim();
			return !url || isSupportedSoDialedUrl(url)
				? undefined
				: {
						kind: 'supportedUrl',
						message: 'Paste a supported So Dialed URL, including https://.',
					};
		});
	});
	protected readonly importError = signal('');
	protected readonly loading = computed(() => {
		const outcome = this.store.outcome();
		return outcome.status === 'pending' && outcome.command.kind === 'preview';
	});

	constructor() {
		let previousCarId: string | undefined;
		effect(() => {
			const carId = this.carId();
			if (previousCarId !== undefined && carId !== previousCarId) this.reset();
			previousCarId = carId;
		});
		effect(() => {
			const outcome = this.store.outcome();
			if (
				outcome.status === 'pending' &&
				outcome.command.kind === 'cancel-import'
			) {
				this.reset();
				return;
			}
			if (
				outcome.status === 'succeeded' &&
				outcome.command.kind === 'save' &&
				outcome.command.importDraft
			)
				this.reset();
		});
		effect(() => {
			const outcome = this.store.outcome();
			if (
				outcome.status === 'idle' ||
				outcome.status === 'pending' ||
				outcome.operationId === this.handledOutcomeId
			)
				return;
			this.handledOutcomeId = outcome.operationId;
			if (outcome.command.kind === 'preview' && outcome.status === 'failed') {
				this.importError.set(previewFailureMessage(outcome.error));
			}
		});
	}

	protected previewImport(event?: Event): void {
		event?.preventDefault();
		this.importUrlForm.url().markAsTouched();
		this.importError.set('');
		if (this.importUrlForm().invalid()) {
			this.importUrlForm.url().focusBoundControl();
			return;
		}
		const carId = this.carId();
		if (!carId || this.archived() || this.store.outcome().status === 'pending')
			return;
		this.store.mutate({
			kind: 'preview',
			url: this.importUrlModel().url.trim(),
			carId,
		});
	}

	private reset(): void {
		this.importError.set('');
		this.importUrlForm().reset({ url: '' });
	}
}
