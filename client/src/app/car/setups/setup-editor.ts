import {
	Component,
	effect,
	inject,
	input,
	output,
	signal,
} from '@angular/core';
import {
	FormField,
	form,
	maxLength,
	required,
	validate,
} from '@angular/forms/signals';
import { LucideSave, LucideTriangleAlert } from '@lucide/angular';
import {
	emptySetupForm,
	setupFieldLabel,
	setupFormFromImport,
	setupFormFromSnapshot,
	setupSaveCommand,
	setupSectionFields,
	setupSectionLabels,
} from './setup-form';
import {
	type ImportedCarIdentity,
	SetupImportReview,
} from './setup-import-review';
import type {
	ImportCarOption,
	SetupGatewayFailure,
	SetupSnapshot,
	SoDialedImportPreview,
} from './setup-snapshot';
import { setupSectionKeys } from './setup-snapshot';
import { SetupSnapshotStore } from './setup-snapshot-store';

export type SetupEditorMode = 'add' | 'edit';

const SETUP_VALIDATION_MESSAGE =
	'Review the highlighted setup fields before saving.';

const isValidOptionalUrl = (value: string): boolean => {
	if (!value.trim()) return true;
	try {
		return ['http:', 'https:'].includes(new URL(value.trim()).protocol);
	} catch {
		return false;
	}
};

const saveFailureMessage = (error: SetupGatewayFailure): string =>
	error.kind === 'http' && error.status === 401
		? 'Your garage session has expired. Sign in again to continue.'
		: 'The setup could not be saved. Check the details and try again.';

@Component({
	selector: 'app-setup-editor',
	imports: [FormField, LucideSave, LucideTriangleAlert, SetupImportReview],
	templateUrl: './setup-editor.html',
})
export class SetupEditor {
	private readonly store = inject(SetupSnapshotStore);
	private handledOutcomeId = this.store.outcome().operationId;
	readonly carId = input('');
	readonly mode = input<SetupEditorMode>('add');
	readonly setup = input<SetupSnapshot | null>(null);
	readonly importPreview = input<SoDialedImportPreview | null>(null);
	readonly importSourceUrl = input('');
	readonly availableCars = input<ImportCarOption[]>([]);
	readonly cancelled = output<void>();
	readonly createCarFromImport = output<ImportedCarIdentity>();
	protected readonly action = this.store.action;
	protected readonly formModel = signal(emptySetupForm());
	protected readonly setupForm = form(this.formModel, (path) => {
		required(path.name, { message: 'Name this setup before saving.' });
		validate(path.name, ({ value }) =>
			!value() || value().trim()
				? undefined
				: {
						kind: 'blankName',
						message: 'Name this setup before saving.',
					},
		);
		maxLength(path.name, 160, { message: 'Use 160 characters or fewer.' });
		maxLength(path.track, 160, {
			message: 'Use 160 characters or fewer for the track.',
		});
		maxLength(path.event, 160, {
			message: 'Use 160 characters or fewer for the event.',
		});
		maxLength(path.surface, 120, {
			message: 'Use 120 characters or fewer for the surface.',
		});
		maxLength(path.traction, 120, {
			message: 'Use 120 characters or fewer for traction.',
		});
		maxLength(path.moisture, 120, {
			message: 'Use 120 characters or fewer for moisture.',
		});
		maxLength(path.condition, 120, {
			message: 'Use 120 characters or fewer for the condition.',
		});
		maxLength(path.temperature, 80, {
			message: 'Use 80 characters or fewer for temperature.',
		});
		maxLength(path.pdfTitle, 240, {
			message: 'Use 240 characters or fewer for the PDF reference.',
		});
		validate(path.sourceUrl, ({ value }) =>
			isValidOptionalUrl(value())
				? undefined
				: {
						kind: 'sourceUrl',
						message: 'Use a complete HTTP or HTTPS source URL.',
					},
		);
		validate(path.pdfPage, ({ value }) =>
			!value().trim() || /^[1-9]\d*$/.test(value().trim())
				? undefined
				: {
						kind: 'pdfPage',
						message: 'PDF page must be a positive whole number.',
					},
		);
	});
	protected readonly formError = signal('');
	protected readonly importTarget = signal({ carId: '' });
	protected readonly sectionKeys = setupSectionKeys;
	protected readonly sectionLabels = setupSectionLabels;
	protected readonly sectionFields = setupSectionFields;
	protected readonly fieldLabel = setupFieldLabel;

	constructor() {
		effect(() => {
			const preview = this.importPreview();
			const setup = this.setup();
			const carId = this.carId();
			this.formError.set('');
			this.importTarget.set({ carId });
			this.setupForm().reset(
				preview
					? setupFormFromImport(preview, this.importSourceUrl())
					: setup
						? setupFormFromSnapshot(setup)
						: emptySetupForm(),
			);
		});
		effect(() => {
			if (
				!this.setupForm().invalid() &&
				this.formError() === SETUP_VALIDATION_MESSAGE
			)
				this.formError.set('');
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
			if (outcome.command.kind === 'save' && outcome.status === 'failed') {
				this.formError.set(saveFailureMessage(outcome.error));
			}
		});
	}

	protected save(event?: Event): void {
		event?.preventDefault();
		this.setupForm().markAsTouched();
		if (this.setupForm().invalid()) {
			this.formError.set(SETUP_VALIDATION_MESSAGE);
			[
				this.setupForm.name(),
				this.setupForm.track(),
				this.setupForm.event(),
				this.setupForm.surface(),
				this.setupForm.traction(),
				this.setupForm.moisture(),
				this.setupForm.condition(),
				this.setupForm.temperature(),
				this.setupForm.sourceUrl(),
				this.setupForm.pdfTitle(),
				this.setupForm.pdfPage(),
			]
				.find((field) => field.invalid())
				?.focusBoundControl();
			return;
		}
		if (this.action()) return;
		const carId = this.carId();
		if (!carId) return;
		this.formError.set('');
		const preview = this.importPreview();
		const targetCarId = preview ? this.importTarget().carId || carId : carId;
		this.store.mutate(
			setupSaveCommand(this.formModel(), {
				sourceCarId: carId,
				targetCarId,
				mode: this.mode(),
				setupId: preview ? null : (this.setup()?.id ?? null),
				importPreview: preview,
			}),
		);
	}

	protected cancel(): void {
		if (this.action()) return;
		const preview = this.importPreview();
		if (preview)
			this.store.mutate({ kind: 'cancel-import', draftId: preview.draftId });
		this.cancelled.emit();
	}
}
