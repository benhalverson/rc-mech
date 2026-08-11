import {
	Component,
	computed,
	effect,
	inject,
	input,
	signal,
} from '@angular/core';
import {
	FormField,
	maxLength,
	required,
	form as signalForm,
	validate,
} from '@angular/forms/signals';
import {
	LucideArchive,
	LucideArchiveRestore,
	LucideCheck,
	LucidePencil,
	LucideRefreshCw,
	LucideSave,
	LucideTriangleAlert,
} from '@lucide/angular';
import type { GarageCar, GarageCarInput } from '../garage/garage-store';
import { VoiceNoteWorkspace } from '../voice/voice-note-workspace';
import { CarSectionShell } from './car-section-shell';
import { CarStore } from './car-store';
import { CurrentSetup } from './current-setup/current-setup';

type CarForm = {
	name: string;
	make: string;
	model: string;
	scale: string;
	vehicleType: string;
	powerType: string;
	notes: string;
};

const emptyCarForm = (): CarForm => ({
	name: '',
	make: '',
	model: '',
	scale: '',
	vehicleType: '',
	powerType: '',
	notes: '',
});

const carFormFrom = (car: GarageCar): CarForm => ({
	name: car.name,
	make: car.make ?? car.manufacturer ?? '',
	model: car.model ?? '',
	scale: car.scale ?? '',
	vehicleType: car.vehicleType ?? '',
	powerType: car.powerType ?? '',
	notes: car.notes ?? '',
});

const carPayload = (form: CarForm): GarageCarInput => ({
	name: form.name.trim(),
	make: form.make.trim(),
	model: form.model.trim(),
	scale: form.scale.trim(),
	vehicleType: form.vehicleType.trim(),
	powerType: form.powerType.trim(),
	notes: form.notes.trim(),
});

const changedCarPayload = (
	form: CarForm,
	baseline: CarForm,
): Partial<GarageCarInput> => {
	const current = carPayload(form);
	const original = carPayload(baseline);
	return Object.fromEntries(
		(Object.keys(current) as (keyof GarageCarInput)[])
			.filter((field) => current[field] !== original[field])
			.map((field) => [field, current[field]]),
	) as Partial<GarageCarInput>;
};

export const carFormValidationMessage = ([error]: readonly {
	readonly message?: string;
}[]): string => error?.message ?? 'Review the car details.';

@Component({
	selector: 'app-car-overview',
	host: { class: 'block' },
	imports: [
		CarSectionShell,
		CurrentSetup,
		FormField,
		LucideArchive,
		LucideArchiveRestore,
		LucideCheck,
		LucidePencil,
		LucideRefreshCw,
		LucideSave,
		LucideTriangleAlert,
		VoiceNoteWorkspace,
	],
	templateUrl: './car-overview.html',
})
export class CarOverview {
	readonly carId = input('');
	protected readonly store = inject(CarStore);
	protected readonly editing = signal(false);
	protected readonly form = signal(emptyCarForm());
	private readonly editBaseline = signal(emptyCarForm());
	protected readonly carFields = signalForm(this.form, (path) => {
		required(path.name, { message: 'Give this car a name before saving.' });
		validate(path.name, ({ value }) =>
			!value() || value().trim()
				? undefined
				: { kind: 'blankName', message: 'Give this car a name before saving.' },
		);
		maxLength(path.name, 120, {
			message: 'Use 120 characters or fewer for the car name.',
		});
		for (const field of [path.make, path.model])
			maxLength(field, 120, { message: 'Use 120 characters or fewer.' });
		maxLength(path.scale, 20, { message: 'Use 20 characters or fewer.' });
		for (const field of [path.vehicleType, path.powerType])
			maxLength(field, 80, { message: 'Use 80 characters or fewer.' });
		maxLength(path.notes, 4000, {
			message: 'Use 4,000 characters or fewer for notes.',
		});
	});
	private readonly formValidationError = signal('');
	protected readonly formError = computed(
		() => this.formValidationError() || this.store.carMutationError(),
	);

	constructor() {
		let previousCarId = this.carId();
		let handledOperationId: number | null = null;
		effect(() => {
			const carId = this.carId();
			if (!carId) return;
			if (carId !== previousCarId) {
				previousCarId = carId;
				this.editing.set(false);
				this.editBaseline.set(emptyCarForm());
				this.formValidationError.set('');
				this.store.clearCarMutationState();
				this.carFields().reset(emptyCarForm());
			}
			this.store.selectCar(carId);
		});
		effect(() => {
			const outcome = this.store.updateOutcome();
			if (
				outcome.status !== 'succeeded' ||
				outcome.operationId === handledOperationId
			)
				return;
			handledOperationId = outcome.operationId;
			this.editing.set(false);
			this.editBaseline.set(emptyCarForm());
		});
	}

	protected openEdit(car: GarageCar): void {
		if (
			this.store.carAction() ||
			this.store.lifecycleAction() ||
			!this.store.mutationsAvailable()
		)
			return;
		this.store.clearCarMutationState();
		this.formValidationError.set('');
		const form = carFormFrom(car);
		this.editBaseline.set(form);
		this.carFields().reset(form);
		this.editing.set(true);
	}

	protected cancelEdit(): void {
		if (this.store.carAction() || !this.store.mutationsAvailable()) return;
		this.editing.set(false);
		this.editBaseline.set(emptyCarForm());
		this.formValidationError.set('');
		this.store.clearCarMutationState();
		this.carFields().reset();
	}

	protected save(event: Event): void {
		event.preventDefault();
		if (this.store.carAction()) return;
		this.carFields().markAsTouched();
		if (this.carFields().invalid()) {
			this.formValidationError.set(
				carFormValidationMessage(this.carFields().errorSummary()),
			);
			this.carFields.name().focusBoundControl();
			return;
		}
		this.formValidationError.set('');
		const baseline = this.editBaseline();
		const changes = changedCarPayload(this.form(), baseline);
		if (!Object.keys(changes).length) {
			this.editing.set(false);
			this.editBaseline.set(emptyCarForm());
			return;
		}
		this.store.updateCar(changes);
	}
}
