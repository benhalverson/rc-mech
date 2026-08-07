import { HttpClient, httpResource } from '@angular/common/http';
import {
	Component,
	computed,
	effect,
	inject,
	input,
	signal,
} from '@angular/core';
import { Router } from '@angular/router';
import type { GarageCar } from '../garage/garage-store';
import { SetupSnapshots } from '../setup-snapshots';
import { CarSectionShell } from './car-section-shell';
import { CarStore } from './car-store';

@Component({
	selector: 'app-car-setups',
	imports: [CarSectionShell, SetupSnapshots],
	template: `
		@if (carStore.loading()) { <div class="state-card" role="status">Opening the car record…</div> }
		@else if (carStore.error()) { <div class="state-card" role="alert"><p>{{ carStore.error() }}</p>@if (!carStore.notFound()) { <button type="button" (click)="carStore.retry()">Try again</button> }</div> }
		@else if (carStore.car(); as car) {
			<app-car-section-shell [car]="car" section="setups">
				@if (createError()) { <p role="alert">{{ createError() }}</p> }
				@if (createAction()) { <p role="status">Creating the new car…</p> }
				<app-setup-snapshots [carId]="car.id" [archived]="!!car.archivedAt" [availableCars]="availableCars()" (createCarFromImport)="createCar($event)" />
			</app-car-section-shell>
		}
	`,
})
export class CarSetups {
	readonly carId = input('');
	protected readonly carStore = inject(CarStore);
	private readonly http = inject(HttpClient);
	private readonly router = inject(Router);
	private readonly collection = httpResource<{ cars: GarageCar[] }>(() => ({
		url: '/api/v1/cars',
		withCredentials: true,
	}));
	protected readonly availableCars = computed(() =>
		this.collection.hasValue() ? this.collection.value().cars : [],
	);
	protected readonly createError = signal('');
	protected readonly createAction = signal(false);

	constructor() {
		effect(() => {
			const carId = this.carId();
			if (carId) this.carStore.selectCar(carId);
		});
	}

	protected createCar(identity: {
		name: string;
		make: string;
		model: string;
	}): void {
		if (this.createAction()) return;
		this.createAction.set(true);
		this.createError.set('');
		this.http
			.post<{ car: GarageCar }>('/api/v1/cars', identity, {
				withCredentials: true,
			})
			.subscribe({
				next: ({ car }) => {
					this.createAction.set(false);
					this.collection.reload();
					void this.router.navigate(['/garage', car.id, 'setups']);
				},
				error: () => {
					this.createAction.set(false);
					this.createError.set(
						'The new car could not be created from this reviewed import.',
					);
				},
			});
	}
}
