import { Component, effect, inject, input } from '@angular/core';
import { CarPhotoGallery } from '../car-photo-gallery';
import { CarSectionShell } from './car-section-shell';
import { CarStore } from './car-store';

@Component({
	selector: 'app-car-photos',
	imports: [CarPhotoGallery, CarSectionShell],
	template: `
		@if (carStore.loading()) { <div class="state-card" role="status">Opening the car record…</div> }
		@else if (carStore.error()) { <div class="state-card" role="alert"><p>{{ carStore.error() }}</p>@if (!carStore.notFound()) { <button type="button" (click)="carStore.retry()">Try again</button> }</div> }
		@else if (carStore.car(); as car) {
			<app-car-section-shell [car]="car" section="photos">
				<app-car-photo-gallery [carId]="car.id" [archived]="!!car.archivedAt" />
			</app-car-section-shell>
		}
	`,
})
export class CarPhotos {
	readonly carId = input('');
	protected readonly carStore = inject(CarStore);

	constructor() {
		effect(() => {
			const carId = this.carId();
			if (carId) this.carStore.selectCar(carId);
		});
	}
}
