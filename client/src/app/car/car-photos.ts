import { Component, effect, inject, input } from '@angular/core';
import { LucideRefreshCw, LucideTriangleAlert } from '@lucide/angular';
import { CarPhotoGallery } from '../car-photo-gallery';
import { CarSectionShell } from './car-section-shell';
import { CarStore } from './car-store';

@Component({
	selector: 'app-car-photos',
	host: { class: 'block' },
	imports: [
		CarPhotoGallery,
		CarSectionShell,
		LucideRefreshCw,
		LucideTriangleAlert,
	],
	templateUrl: './car-photos.html',
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
