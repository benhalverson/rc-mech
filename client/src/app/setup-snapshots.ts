import { DatePipe, DecimalPipe, JsonPipe, KeyValuePipe } from '@angular/common';
import {
	Component,
	computed,
	effect,
	inject,
	input,
	linkedSignal,
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
import {
	LucideCheck,
	LucideClipboardList,
	LucideCopy,
	LucideExternalLink,
	LucideFileInput,
	LucidePlus,
	LucideRefreshCw,
	LucideSave,
	LucideTriangleAlert,
} from '@lucide/angular';
import { switchMap } from 'rxjs';
import {
	emptySetupForm,
	importKnownValues,
	parseSetupJsonObject,
	setupFormFromImport,
	setupFormFromSnapshot,
	setupPayloadFromForm,
	setupSectionFields,
} from './setup-form';
import {
	type ImportCarOption,
	type SetupSectionKey,
	type SetupSectionValues,
	type SetupSnapshot,
	SetupSnapshotService,
	SoDialedImporterClient,
	type SoDialedImportPreview,
	setupSectionKeys,
} from './setup-snapshot';
import { SetupSnapshotStore } from './setup-snapshot-store';

type SetupMode = 'add' | 'edit';
type SetupAction = 'save' | 'copy' | 'current' | null;
type ImportState = 'idle' | 'loading' | 'review' | 'error';

const SETUP_VALIDATION_MESSAGE =
	'Review the highlighted setup fields before saving.';

const sectionLabels: Record<SetupSectionKey, string> = {
	vehicle: 'Vehicle',
	drivetrain: 'Drivetrain',
	electronics: 'Electronics',
	tires: 'Tires',
	shocks: 'Shocks',
	frontSuspension: 'Front suspension',
	rearSuspension: 'Rear suspension',
	notes: 'Notes',
};

const isValidOptionalUrl = (value: string): boolean => {
	if (!value.trim()) return true;
	try {
		return ['http:', 'https:'].includes(new URL(value.trim()).protocol);
	} catch {
		return false;
	}
};

const isSessionExpired = (error: unknown): boolean =>
	typeof error === 'object' &&
	error !== null &&
	'status' in error &&
	error.status === 401;

@Component({
	selector: 'app-setup-snapshots',
	host: { class: 'block' },
	imports: [
		DatePipe,
		DecimalPipe,
		FormField,
		JsonPipe,
		KeyValuePipe,
		LucideCheck,
		LucideClipboardList,
		LucideCopy,
		LucideExternalLink,
		LucideFileInput,
		LucidePlus,
		LucideRefreshCw,
		LucideSave,
		LucideTriangleAlert,
	],
	templateUrl: './setup-snapshots.html',
})
export class SetupSnapshots {
	private readonly service = inject(SetupSnapshotService);
	private readonly importer = inject(SoDialedImporterClient);
	private readonly readStore = inject(SetupSnapshotStore);
	readonly carId = input('');
	readonly archived = input(false);
	readonly availableCars = input<ImportCarOption[]>([]);
	readonly createCarFromImport = output<{
		name: string;
		make: string;
		model: string;
	}>();
	protected readonly setups = linkedSignal(() => this.readStore.setups());
	protected readonly selectedId = signal<string | null>(null);
	protected readonly state = computed(() =>
		this.readStore.loading()
			? 'loading'
			: this.readStore.failure()
				? 'error'
				: 'ready',
	);
	protected readonly actionError = signal('');
	protected readonly actionMessage = signal('');
	protected readonly readFailure = this.readStore.failure;
	protected readonly mode = signal<SetupMode>('add');
	protected readonly editing = signal(false);
	protected readonly action = signal<SetupAction>(null);
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
	protected readonly importUrlModel = signal({ url: '' });
	protected readonly importUrlForm = form(this.importUrlModel, (path) => {
		required(path.url, { message: 'Paste a So Dialed setup URL.' });
		validate(path.url, ({ value }) => {
			const input = value();
			if (!input) return undefined;
			const url = input.trim();
			if (!url)
				return {
					kind: 'blankUrl',
					message: 'Paste a So Dialed setup URL.',
				};
			return SoDialedImporterClient.isSupportedUrl(url)
				? undefined
				: {
						kind: 'supportedUrl',
						message: 'Paste a supported So Dialed URL, including https://.',
					};
		});
	});
	protected readonly importState = signal<ImportState>('idle');
	protected readonly importError = signal('');
	protected readonly importPreview = signal<SoDialedImportPreview | null>(null);
	protected readonly importCarModel = signal({ carId: '' });
	protected readonly importCarForm = form(this.importCarModel);
	protected readonly sectionKeys = setupSectionKeys;
	protected readonly sectionLabels = sectionLabels;
	protected readonly sectionFields = setupSectionFields;

	protected readonly selected = computed(
		() => this.setups().find((setup) => setup.id === this.selectedId()) ?? null,
	);
	protected readonly copySource = computed(
		() =>
			this.setups().find((setup) => setup.current) ?? this.setups()[0] ?? null,
	);

	constructor() {
		let previousCarId: string | undefined;
		effect(() => {
			const carId = this.carId();
			if (previousCarId !== undefined && carId !== previousCarId)
				this.resetRouteState();
			previousCarId = carId;
		});
		effect(() => {
			const carId = this.carId();
			if (carId) this.readStore.selectCar(carId);
		});
		effect(() => {
			const setups = this.setups();
			if (!setups.some((setup) => setup.id === this.selectedId()))
				this.selectedId.set(
					setups.find((setup) => setup.current)?.id ?? setups[0]?.id ?? null,
				);
		});
		effect(() => {
			if (
				!this.setupForm().invalid() &&
				this.formError() === SETUP_VALIDATION_MESSAGE
			)
				this.formError.set('');
		});
	}

	private resetRouteState(): void {
		this.selectedId.set(null);
		this.mode.set('add');
		this.editing.set(false);
		this.action.set(null);
		this.setupForm().reset(emptySetupForm());
		this.formError.set('');
		this.actionError.set('');
		this.actionMessage.set('');
		this.importState.set('idle');
		this.importError.set('');
		this.importPreview.set(null);
		this.importUrlForm().reset({ url: '' });
		this.importCarForm().reset({ carId: '' });
	}

	protected retry(): void {
		this.readStore.retry();
	}

	protected select(setup: SetupSnapshot): void {
		this.selectedId.set(setup.id);
	}

	protected openAdd(): void {
		this.mode.set('add');
		this.setupForm().reset(emptySetupForm());
		this.formError.set('');
		this.editing.set(true);
	}

	protected copyPrevious(): void {
		const source = this.copySource();
		if (source) this.copySetup(source);
	}

	protected updateImportUrl(value: string): void {
		this.importUrlModel.set({ url: value });
	}

	protected previewImport(event?: Event): void {
		event?.preventDefault();
		this.importUrlForm.url().markAsTouched();
		const url = this.importUrlModel().url.trim();
		this.importError.set('');
		if (this.importUrlForm().invalid()) {
			this.importState.set('error');
			this.importUrlForm.url().focusBoundControl();
			return;
		}
		if (this.archived()) return;
		const carId = this.carId();
		this.importState.set('loading');
		this.importer.preview(url, carId).subscribe({
			next: (preview) => {
				if (this.carId() !== carId) return;
				this.importPreview.set(preview);
				this.importCarModel.set({ carId });
				this.mode.set('add');
				this.setupForm().reset(setupFormFromImport(preview, url));
				this.formError.set('');
				this.editing.set(true);
				this.importState.set('review');
			},
			error: (error: unknown) => {
				if (this.carId() !== carId) return;
				this.importState.set('error');
				this.importError.set(
					isSessionExpired(error)
						? 'Your garage session has expired. Sign in again to continue.'
						: error instanceof Error && error.message
							? error.message
							: 'That source could not be read. Check the link and try again.',
				);
			},
		});
	}

	protected cancelImport(): void {
		const draftId = this.importPreview()?.draftId;
		if (draftId) this.importer.cancel(draftId).subscribe();
		this.importPreview.set(null);
		this.importState.set('idle');
		this.importError.set('');
		this.importUrlForm().reset({ url: '' });
		this.cancelEdit();
	}

	protected requestCreateCar(): void {
		const identity = this.importPreview()?.carIdentity;
		if (!identity) return;
		this.createCarFromImport.emit({
			name:
				identity.name ||
				[identity.make, identity.model].filter(Boolean).join(' ') ||
				'Imported car',
			make: identity.make ?? '',
			model: identity.model ?? '',
		});
	}

	protected openEdit(): void {
		const setup = this.selected();
		if (!setup || this.archived()) return;
		this.mode.set('edit');
		this.setupForm().reset(setupFormFromSnapshot(setup));
		this.formError.set('');
		this.editing.set(true);
	}

	protected cancelEdit(): void {
		this.editing.set(false);
		this.formError.set('');
		this.setupForm().reset();
	}

	protected save(event?: Event): void {
		event?.preventDefault();
		this.setupForm().markAsTouched();
		const formModel = this.formModel();
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
		this.action.set('save');
		this.actionError.set('');
		this.actionMessage.set('');
		this.formError.set('');
		const sourceCarId = this.carId();
		const setup = this.importPreview() ? null : this.selected();
		const importDraft = this.importPreview();
		const reviewValues = parseSetupJsonObject(formModel.unmappedValues);
		const targetCarId = importDraft
			? this.importCarModel().carId || sourceCarId
			: sourceCarId;
		const payload = setupPayloadFromForm(formModel);
		const request =
			this.mode() === 'edit' && setup
				? this.service.update(sourceCarId, setup.id, payload)
				: importDraft
					? this.importer
							.update(importDraft.draftId, {
								carId: targetCarId,
								knownValues: importKnownValues(payload),
								uncertainValues:
									(reviewValues['uncertain'] as
										| Record<string, unknown>
										| undefined) ?? importDraft.uncertainValues,
								rawValues: parseSetupJsonObject(formModel.rawValues),
								unmappedValues:
									(reviewValues['unmapped'] as
										| Record<string, unknown>
										| undefined) ?? {},
								sourceMetadata: { ...payload.sourceMetadata },
							})
							.pipe(
								switchMap(() =>
									this.importer.accept(
										importDraft.draftId,
										targetCarId,
										formModel.name.trim(),
									),
								),
							)
					: this.service.create(targetCarId, payload);
		request.subscribe({
			next: ({ setup: saved }) => {
				if (this.carId() !== sourceCarId) return;
				this.editing.set(false);
				this.action.set(null);
				this.importPreview.set(null);
				this.importState.set('idle');
				this.importUrlForm().reset({ url: '' });
				if (targetCarId === sourceCarId) {
					this.replaceSetup(saved);
					this.selectedId.set(saved.id);
					this.readStore.refresh();
				} else {
					this.actionMessage.set('Imported setup saved to the selected car.');
				}
			},
			error: (error: unknown) => {
				if (this.carId() !== sourceCarId) return;
				this.action.set(null);
				this.formError.set(
					isSessionExpired(error)
						? 'Your garage session has expired. Sign in again to continue.'
						: 'The setup could not be saved. Check the details and try again.',
				);
			},
		});
	}

	protected copy(): void {
		const setup = this.selected();
		if (setup) this.copySetup(setup);
	}

	private copySetup(setup: SetupSnapshot): void {
		if (!setup || this.archived() || this.action()) return;
		const carId = this.carId();
		this.action.set('copy');
		this.actionError.set('');
		this.actionMessage.set('');
		this.service.copy(carId, setup.id).subscribe({
			next: ({ setup: copied }) => {
				if (this.carId() !== carId) return;
				this.action.set(null);
				this.replaceSetup(copied);
				this.selectedId.set(copied.id);
				this.mode.set('edit');
				this.setupForm().reset(setupFormFromSnapshot(copied));
				this.editing.set(true);
				this.readStore.refresh();
			},
			error: (error: unknown) => {
				if (this.carId() !== carId) return;
				this.action.set(null);
				this.actionError.set(
					isSessionExpired(error)
						? 'Your garage session has expired. Sign in again to continue.'
						: 'The setup could not be copied.',
				);
			},
		});
	}

	protected makeCurrent(): void {
		const setup = this.selected();
		if (!setup || setup.current || this.archived() || this.action()) return;
		const carId = this.carId();
		this.action.set('current');
		this.actionError.set('');
		this.actionMessage.set('');
		this.service.selectCurrent(carId, setup.id).subscribe({
			next: ({ setup: current }) => {
				if (this.carId() !== carId) return;
				this.action.set(null);
				this.setups.update((setups) =>
					setups.map((item) => ({ ...item, current: item.id === current.id })),
				);
				this.readStore.refresh();
			},
			error: (error: unknown) => {
				if (this.carId() !== carId) return;
				this.action.set(null);
				this.actionError.set(
					isSessionExpired(error)
						? 'Your garage session has expired. Sign in again to continue.'
						: 'The current setup could not be changed.',
				);
			},
		});
	}

	protected displayName(field: string): string {
		return field
			.replace(/([A-Z])/g, ' $1')
			.replace(/^./, (letter) => letter.toUpperCase());
	}

	protected importValueCount(values: Record<string, unknown>): number {
		return Object.keys(values).length;
	}

	protected sectionHasValues(section: SetupSectionValues): boolean {
		return Object.values(section).some((value) => Boolean(value));
	}

	private replaceSetup(updated: SetupSnapshot): void {
		this.setups.update((setups) => {
			const found = setups.some((setup) => setup.id === updated.id);
			return found
				? setups.map((setup) => (setup.id === updated.id ? updated : setup))
				: [updated, ...setups];
		});
	}
}
