import { DatePipe, DecimalPipe, JsonPipe, KeyValuePipe } from '@angular/common';
import {
	ChangeDetectionStrategy,
	Component,
	effect,
	inject,
	input,
	signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
	SetupContext,
	SetupSectionKey,
	SetupSections,
	SetupSectionValues,
	SetupSnapshot,
	SetupSnapshotPayload,
	SetupSnapshotService,
	SetupSource,
	setupSectionKeys,
} from './setup-snapshot';

type SetupState = 'loading' | 'ready' | 'error';
type SetupMode = 'add' | 'edit';
type SetupAction = 'save' | 'copy' | 'current' | null;

type SetupForm = {
	name: string;
	recordedAt: string;
	track: string;
	event: string;
	surface: string;
	traction: string;
	moisture: string;
	condition: string;
	temperature: string;
	sourceUrl: string;
	pdfUrl: string;
	pdfTitle: string;
	pdfPage: string;
	sections: SetupSections;
	unmappedValues: string;
};

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

const sectionFields: Record<SetupSectionKey, string[]> = {
	vehicle: ['rideHeight', 'weight', 'wheelbase'],
	drivetrain: ['motor', 'pinion', 'spur', 'diffOil'],
	electronics: ['esc', 'escSettings', 'servo', 'battery'],
	tires: ['front', 'rear', 'insert', 'wheels'],
	shocks: ['frontOil', 'rearOil', 'frontSpring', 'rearSpring'],
	frontSuspension: ['camber', 'caster', 'toe', 'swayBar'],
	rearSuspension: ['camber', 'toe', 'swayBar', 'antiSquat'],
	notes: ['setupNotes'],
};

const emptySections = (): SetupSections =>
	Object.fromEntries(
		setupSectionKeys.map((key) => [
			key,
			Object.fromEntries(sectionFields[key].map((field) => [field, ''])),
		]),
	) as SetupSections;

const emptyForm = (): SetupForm => ({
	name: '',
	recordedAt: '',
	track: '',
	event: '',
	surface: '',
	traction: '',
	moisture: '',
	condition: '',
	temperature: '',
	sourceUrl: '',
	pdfUrl: '',
	pdfTitle: '',
	pdfPage: '',
	sections: emptySections(),
	unmappedValues: '',
});

const formFrom = (setup: SetupSnapshot): SetupForm => ({
	...emptyForm(),
	name: setup.name,
	recordedAt: setup.context?.recordedAt?.slice(0, 10) ?? '',
	track: setup.context?.track ?? '',
	event: setup.context?.event ?? '',
	surface: setup.context?.surface ?? '',
	traction: setup.context?.traction ?? '',
	moisture: setup.context?.moisture ?? '',
	condition: setup.context?.condition ?? '',
	temperature: setup.context?.temperature ?? '',
	sourceUrl: setup.source?.url ?? '',
	pdfUrl: setup.source?.pdfUrl ?? '',
	pdfTitle: setup.source?.pdfTitle ?? '',
	pdfPage: setup.source?.pdfPage == null ? '' : String(setup.source.pdfPage),
	sections: setup.sections ?? emptySections(),
	unmappedValues: setup.unmappedValues
		? JSON.stringify(setup.unmappedValues, null, 2)
		: '',
});

const optionalRecord = (values: Record<string, string | null>) =>
	Object.fromEntries(
		Object.entries(values)
			.map(([key, value]) => [key, value?.trim() ?? ''])
			.filter(([, value]) => value),
	);

const payloadFrom = (form: SetupForm): SetupSnapshotPayload => {
	const context: SetupContext = {
		recordedAt: form.recordedAt || null,
		track: form.track.trim() || null,
		event: form.event.trim() || null,
		surface: form.surface.trim() || null,
		traction: form.traction.trim() || null,
		moisture: form.moisture.trim() || null,
		condition: form.condition.trim() || null,
		temperature: form.temperature.trim() || null,
	};
	const source: SetupSource = {
		url: form.sourceUrl.trim() || null,
		pdfUrl: form.pdfUrl.trim() || null,
		pdfTitle: form.pdfTitle.trim() || null,
		pdfPage: form.pdfPage.trim() ? Number(form.pdfPage) : null,
	};
	let unmappedValues: Record<string, unknown> | null = null;
	if (form.unmappedValues.trim()) {
		try {
			const parsed: unknown = JSON.parse(form.unmappedValues);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
				unmappedValues = parsed as Record<string, unknown>;
		} catch {
			unmappedValues = { raw: form.unmappedValues.trim() };
		}
	}
	return {
		name: form.name.trim(),
		context,
		sections: Object.fromEntries(
			setupSectionKeys.map((key) => [key, optionalRecord(form.sections[key])]),
		) as SetupSections,
		source,
		unmappedValues,
	};
};

@Component({
	selector: 'app-setup-snapshots',
	imports: [DatePipe, DecimalPipe, JsonPipe, KeyValuePipe, FormsModule],
	templateUrl: './setup-snapshots.html',
	styleUrl: './setup-snapshots.css',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetupSnapshots {
	private readonly service = inject(SetupSnapshotService);
	readonly carId = input.required<string>();
	readonly archived = input(false);
	protected readonly setups = signal<SetupSnapshot[]>([]);
	protected readonly selectedId = signal<string | null>(null);
	protected readonly state = signal<SetupState>('loading');
	protected readonly error = signal('');
	protected readonly mode = signal<SetupMode>('add');
	protected readonly editing = signal(false);
	protected readonly action = signal<SetupAction>(null);
	protected readonly form = signal<SetupForm>(emptyForm());
	protected readonly formError = signal('');
	protected readonly sectionKeys = setupSectionKeys;
	protected readonly sectionLabels = sectionLabels;
	protected readonly sectionFields = sectionFields;

	protected readonly selected = () =>
		this.setups().find((setup) => setup.id === this.selectedId()) ?? null;

	constructor() {
		effect(() => this.load(this.carId()));
	}

	protected load(carId: string): void {
		this.state.set('loading');
		this.error.set('');
		this.service.list(carId).subscribe({
			next: ({ setups }) => {
				this.setups.set(setups);
				this.selectedId.set(
					setups.find((setup) => setup.current)?.id ?? setups[0]?.id ?? null,
				);
				this.state.set('ready');
			},
			error: () => {
				this.state.set('error');
				this.error.set(
					'Setup history could not be loaded. Check the connection and try again.',
				);
			},
		});
	}

	protected retry(): void {
		this.load(this.carId());
	}

	protected select(setup: SetupSnapshot): void {
		this.selectedId.set(setup.id);
	}

	protected openAdd(): void {
		this.mode.set('add');
		this.form.set(emptyForm());
		this.formError.set('');
		this.editing.set(true);
	}

	protected openEdit(): void {
		const setup = this.selected();
		if (!setup || this.archived()) return;
		this.mode.set('edit');
		this.form.set(formFrom(setup));
		this.formError.set('');
		this.editing.set(true);
	}

	protected cancelEdit(): void {
		this.editing.set(false);
		this.formError.set('');
	}

	protected updateField(field: keyof SetupForm, value: string): void {
		this.form.update((form) => ({ ...form, [field]: value }));
	}

	protected updateSectionField(
		section: SetupSectionKey,
		field: string,
		value: string,
	): void {
		this.form.update((form) => ({
			...form,
			sections: {
				...form.sections,
				[section]: { ...form.sections[section], [field]: value },
			},
		}));
	}

	protected save(): void {
		const form = this.form();
		if (!form.name.trim()) {
			this.formError.set('Name this setup before saving.');
			return;
		}
		if (this.action()) return;
		this.action.set('save');
		this.formError.set('');
		const setup = this.selected();
		const request =
			this.mode() === 'edit' && setup
				? this.service.update(this.carId(), setup.id, payloadFrom(form))
				: this.service.create(this.carId(), payloadFrom(form));
		request.subscribe({
			next: ({ setup: saved }) => {
				this.editing.set(false);
				this.action.set(null);
				this.replaceSetup(saved);
				this.selectedId.set(saved.id);
			},
			error: () => {
				this.action.set(null);
				this.formError.set(
					'The setup could not be saved. Check the details and try again.',
				);
			},
		});
	}

	protected copy(): void {
		const setup = this.selected();
		if (!setup || this.archived() || this.action()) return;
		this.action.set('copy');
		this.service.copy(this.carId(), setup.id).subscribe({
			next: ({ setup: copied }) => {
				this.action.set(null);
				this.replaceSetup(copied);
				this.selectedId.set(copied.id);
				this.mode.set('edit');
				this.form.set(formFrom(copied));
				this.editing.set(true);
			},
			error: () => {
				this.action.set(null);
				this.error.set('The setup could not be copied.');
			},
		});
	}

	protected makeCurrent(): void {
		const setup = this.selected();
		if (!setup || setup.current || this.archived() || this.action()) return;
		this.action.set('current');
		this.service.selectCurrent(this.carId(), setup.id).subscribe({
			next: ({ setup: current }) => {
				this.action.set(null);
				this.setups.update((setups) =>
					setups.map((item) => ({ ...item, current: item.id === current.id })),
				);
			},
			error: () => {
				this.action.set(null);
				this.error.set('The current setup could not be changed.');
			},
		});
	}

	protected displayName(field: string): string {
		return field
			.replace(/([A-Z])/g, ' $1')
			.replace(/^./, (letter) => letter.toUpperCase());
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
