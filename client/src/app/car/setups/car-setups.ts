import { HttpClient } from '@angular/common/http';
import { Component, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { GarageCar, GarageCarInput } from '../../garage/garage-store';
import { CarSectionShell } from '../car-section-shell';
import { CarStore } from '../car-store';
import { CarSetupsStore } from './car-setups-store';
import { SetupSnapshots } from './setup-snapshots';

@Component({
	selector: 'app-car-setups',
	imports: [CarSectionShell, SetupSnapshots],
	templateUrl: './car-setups.html',
})
export class CarSetups {
	readonly carId = input('');
	protected readonly carStore = inject(CarStore);
	protected readonly setupsStore = inject(CarSetupsStore);
	private readonly http = inject(HttpClient);
	private readonly router = inject(Router);
	protected readonly createError = signal('');
	protected readonly createAction = signal(false);

	constructor() {
		let previousCarId: string | undefined;
		effect(() => {
			const carId = this.carId();
			if (!carId) return;
			if (previousCarId !== undefined && carId !== previousCarId) {
				this.createAction.set(false);
				this.createError.set('');
			}
			previousCarId = carId;
			this.carStore.selectCar(carId);
		});
	}

	protected createCar(identity: {
		name: string;
		make: string;
		model: string;
	}): void {
		if (this.createAction()) return;
		const sourceCarId = this.carId();
		const make = identity.make.trim();
		const model = identity.model.trim();
		const payload: GarageCarInput = {
			name:
				identity.name.trim() ||
				[make, model].filter(Boolean).join(' ') ||
				'Imported car',
			...(make ? { make } : {}),
			...(model ? { model } : {}),
		};
		this.createAction.set(true);
		this.createError.set('');
		this.http
			.post<{ car: GarageCar }>('/api/v1/cars', payload, {
				withCredentials: true,
			})
			.subscribe({
				next: ({ car }) => {
					if (this.carId() !== sourceCarId) return;
					this.createAction.set(false);
					this.setupsStore.refresh();
					void this.router.navigate(['/garage', car.id, 'setups']);
				},
				error: (error: { status?: number }) => {
					if (this.carId() !== sourceCarId) return;
					this.createAction.set(false);
					this.createError.set(
						error.status === 401
							? 'Your garage session has expired. Sign in again to continue.'
							: 'The new car could not be created from this reviewed import.',
					);
				},
			});
	}
}
