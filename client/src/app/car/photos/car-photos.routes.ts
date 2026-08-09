import type { Routes } from '@angular/router';
import { CarStore } from '../car-store';
import { CarPhotoStore } from './car-photo-store';

export const CAR_PHOTOS_ROUTES: Routes = [
	{
		path: '',
		providers: [CarPhotoStore, CarStore],
		loadComponent: () =>
			import('./car-photos').then(({ CarPhotos }) => CarPhotos),
	},
];
