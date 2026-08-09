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
		effect(() => {
			const carId = this.carId();
			if (!carId) return;
			if (carId !== previousCarId) {
				previousCarId = carId;
				this.editing.set(false);
				this.formValidationError.set('');
				this.store.clearCarMutationState();
				this.carFields().reset(emptyCarForm());
			}
			this.store.selectCar(carId);
		});
	}

	protected openEdit(car: GarageCar): void {
		if (this.store.carAction() || this.store.lifecycleAction()) return;
		this.store.clearCarMutationState();
		this.formValidationError.set('');
		this.carFields().reset(carFormFrom(car));
		this.editing.set(true);
	}

	protected cancelEdit(): void {
		if (this.store.carAction()) return;
		this.editing.set(false);
		this.formValidationError.set('');
		this.store.clearCarMutationState();
		this.carFields().reset();
	}

	protected async save(event: Event): Promise<void> {
		event.preventDefault();
		if (this.store.carAction()) return;
		this.carFields().markAsTouched();
		if (this.carFields().invalid()) {
			this.formValidationError.set(
				this.carFields().errorSummary()[0]?.message ??
					'Review the car details.',
			);
			this.carFields.name().focusBoundControl();
			return;
		}
		this.formValidationError.set('');
		if (await this.store.updateCar(carPayload(this.form())))
			this.editing.set(false);
	}
}
