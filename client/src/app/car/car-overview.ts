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
	imports: [CarSectionShell, CurrentSetup, FormField, VoiceNoteWorkspace],
	template: `
		@if (store.loading()) {
			<div class="state-card" role="status">Opening the car overview…</div>
		} @else if (store.failure(); as failure) {
			<div class="state-card" role="alert"><p>{{ failure.message }}</p>@if (failure.retryable) { <button type="button" (click)="store.retry()">Try again</button> }</div>
		} @else if (store.car(); as car) {
			<app-car-section-shell [car]="car" section="overview">
				<app-current-setup [carId]="car.id" [archived]="!!car.archivedAt" />
				<app-voice-note-workspace class="mt-6" [carId]="car.id" [archived]="!!car.archivedAt" />
				@if (editing()) {
					<form class="car-form" (submit)="save($event)" aria-labelledby="car-form-title" [attr.aria-describedby]="formError() ? 'car-form-error' : null" novalidate>
						<div class="eyebrow">Edit car</div><h3 id="car-form-title">Update the car record.</h3>
						@if (formError()) { <p id="car-form-error" role="alert">{{ formError() }}</p> }
						<div class="form-grid">
							<label class="wide">Name <input [formField]="carFields.name" [attr.aria-describedby]="formError() && carFields.name().invalid() ? 'car-form-error' : null" /></label>
							<label>Make <input [formField]="carFields.make" [attr.aria-describedby]="formError() && carFields.make().invalid() ? 'car-form-error' : null" /></label>
							<label>Model <input [formField]="carFields.model" [attr.aria-describedby]="formError() && carFields.model().invalid() ? 'car-form-error' : null" /></label>
							<label>Scale <input placeholder="1/10" [formField]="carFields.scale" [attr.aria-describedby]="formError() && carFields.scale().invalid() ? 'car-form-error' : null" /></label>
							<label>Vehicle type <input placeholder="Buggy, truck…" [formField]="carFields.vehicleType" [attr.aria-describedby]="formError() && carFields.vehicleType().invalid() ? 'car-form-error' : null" /></label>
							<label>Power type <input placeholder="Electric, nitro…" [formField]="carFields.powerType" [attr.aria-describedby]="formError() && carFields.powerType().invalid() ? 'car-form-error' : null" /></label>
							<label class="wide">Notes <textarea rows="5" [formField]="carFields.notes" [attr.aria-describedby]="formError() && carFields.notes().invalid() ? 'car-form-error' : null"></textarea></label>
						</div>
						<div class="form-actions"><button type="submit" [disabled]="store.carAction() !== null">{{ store.carAction() === 'update' ? 'Saving…' : 'Save car' }}</button><button type="button" (click)="cancelEdit()" [disabled]="store.carAction() !== null">Cancel</button></div>
					</form>
				} @else { <section class="overview" aria-labelledby="overview-title">
					<div class="section-heading"><div><div class="eyebrow">Inspection plate</div><h3 id="overview-title">Car overview</h3></div>
					<div class="overview-actions"><button type="button" (click)="openEdit(car)" [disabled]="store.lifecycleAction() !== null || store.carAction() !== null">Edit details</button>@if (car.archivedAt) { <button type="button" (click)="store.changeArchiveState('restore')" [disabled]="store.lifecycleAction() !== null || store.carAction() !== null">{{ store.lifecycleAction() === 'restore' ? 'Restoring…' : 'Restore car' }}</button> }
					@else { <button type="button" (click)="store.changeArchiveState('archive')" [disabled]="store.lifecycleAction() !== null || store.carAction() !== null">{{ store.lifecycleAction() === 'archive' ? 'Archiving…' : 'Archive car' }}</button> }</div></div>
					@if (store.lifecycleError()) { <p role="alert">{{ store.lifecycleError() }}</p> }
					@if (store.carMessage()) { <p role="status">{{ store.carMessage() }}</p> }
					<dl><div><dt>Scale</dt><dd>{{ car.scale || 'Not recorded' }}</dd></div><div><dt>Vehicle type</dt><dd>{{ car.vehicleType || 'Not recorded' }}</dd></div><div><dt>Power type</dt><dd>{{ car.powerType || 'Not recorded' }}</dd></div></dl>
					<p><strong>Workshop notes</strong><br />{{ car.notes || 'No notes recorded yet.' }}</p>
				</section> }
			</app-car-section-shell>
		}
	`,
	styleUrl: '../garage/garage.css',
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
