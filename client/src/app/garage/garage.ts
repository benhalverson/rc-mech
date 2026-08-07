import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
	FormField,
	maxLength,
	required,
	form as signalForm,
	validate,
} from '@angular/forms/signals';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import {
	type GarageCar,
	type GarageCarInput,
	GarageStore,
} from './garage-store';

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
	imports: [RouterLink, FormField],
	templateUrl: './garage.html',
	styleUrl: './garage.css',
})
export class Garage {
	protected readonly store = inject(GarageStore);
	private readonly route = inject(ActivatedRoute);
	private readonly router = inject(Router);
	private readonly routeCarId = toSignal(
		this.route.paramMap.pipe(map((params) => params.get('carId'))),
		{ initialValue: this.route.snapshot.paramMap.get('carId') },
	);
	protected readonly editing = signal<'create' | 'update' | null>(null);
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
		let previousCarId = this.routeCarId();
		effect(() => {
			const carId = this.routeCarId();
			if (carId !== previousCarId) {
				previousCarId = carId;
				this.editing.set(null);
				this.formValidationError.set('');
				this.store.clearCarMutationState();
				this.carFields().reset(emptyCarForm());
			}
			this.store.selectCar(carId);
		});
	}

	protected openCreate(): void {
		if (this.store.carAction()) return;
		this.store.clearCarMutationState();
		this.formValidationError.set('');
		this.carFields().reset(emptyCarForm());
		this.editing.set('create');
	}

	protected openEdit(car: GarageCar): void {
		if (this.store.carAction()) return;
		this.store.clearCarMutationState();
		this.formValidationError.set('');
		this.carFields().reset(carFormFrom(car));
		this.editing.set('update');
	}

	protected cancelEdit(): void {
		if (this.store.carAction()) return;
		this.editing.set(null);
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
		const input = carPayload(this.form());
		if (this.editing() === 'create') {
			const car = await this.store.createCar(input);
			if (!car) return;
			this.editing.set(null);
			await this.router.navigate(['/garage', car.id, 'overview']);
			return;
		}
		const car = this.store.activeCar();
		if (!car || !(await this.store.updateCar(car.id, input))) return;
		this.editing.set(null);
	}
}
