import { Component, computed, effect, inject, signal } from '@angular/core';
import {
	FormField,
	maxLength,
	required,
	form as signalForm,
	validate,
} from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import {
	LucideArchive,
	LucideArchiveRestore,
	LucideCarFront,
	LucideChevronRight,
	LucidePlus,
	LucideRefreshCw,
	LucideTriangleAlert,
} from '@lucide/angular';
import { type GarageCarInput, GarageStore } from './garage-store';

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

const carPayload = (form: CarForm): GarageCarInput => {
	const payload: GarageCarInput = { name: form.name.trim() };
	for (const [field, value] of [
		['make', form.make],
		['model', form.model],
		['scale', form.scale],
		['vehicleType', form.vehicleType],
		['powerType', form.powerType],
		['notes', form.notes],
	] as const)
		if (value.trim()) payload[field] = value.trim();
	return payload;
};

@Component({
	selector: 'app-garage',
	host: { class: 'block' },
	imports: [
		RouterLink,
		FormField,
		LucideArchive,
		LucideArchiveRestore,
		LucideCarFront,
		LucideChevronRight,
		LucidePlus,
		LucideRefreshCw,
		LucideTriangleAlert,
	],
	templateUrl: './garage.html',
})
export class Garage {
	protected readonly store = inject(GarageStore);
	private readonly router = inject(Router);
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
		let handledOperationId: number | null = null;
		effect(() => {
			const outcome = this.store.createOutcome();
			if (
				outcome.status !== 'succeeded' ||
				outcome.operationId === handledOperationId
			)
				return;
			handledOperationId = outcome.operationId;
			this.editing.set(false);
			void this.router.navigate(['/garage', outcome.car.id, 'overview']);
		});
	}

	protected openCreate(): void {
		if (this.store.carAction()) return;
		this.store.clearCarMutationState();
		this.formValidationError.set('');
		this.carFields().reset(emptyCarForm());
		this.editing.set(true);
	}

	protected cancelEdit(): void {
		if (this.store.carAction()) return;
		this.editing.set(false);
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
				this.carFields().errorSummary()[0]?.message ??
					'Review the car details.',
			);
			this.carFields.name().focusBoundControl();
			return;
		}
		this.formValidationError.set('');
		this.store.createCar({ input: carPayload(this.form()) });
	}
}
