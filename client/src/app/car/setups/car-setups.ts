import { Component, effect, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import type { GarageCarInput } from '../../garage/garage-store';
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
	private readonly router = inject(Router);
	protected readonly createError = this.setupsStore.createError;
	protected readonly createAction = this.setupsStore.createAction;

	constructor() {
		let previousCarId: string | undefined;
		effect(() => {
			const carId = this.carId();
			if (!carId) return;
			if (previousCarId !== undefined && carId !== previousCarId) {
				this.setupsStore.clearCreateOutcome();
			}
			previousCarId = carId;
			this.setupsStore.selectSourceCar(carId);
			this.carStore.selectCar(carId);
		});
		let handledOperationId = 0;
		effect(() => {
			const outcome = this.setupsStore.createOutcome();
			if (
				outcome.status !== 'succeeded' ||
				outcome.operationId === handledOperationId
			)
				return;
			handledOperationId = outcome.operationId;
			void this.router.navigate(['/garage', outcome.car.id, 'setups']);
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
		if (sourceCarId)
			this.setupsStore.createCar({ sourceCarId, input: payload });
	}
}
