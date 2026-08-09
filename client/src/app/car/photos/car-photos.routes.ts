import type { Routes } from '@angular/router';
import { CarGateway } from '../car-gateway';
import { CarStore } from '../car-store';
import { CarPhotoGateway } from './car-photo-gateway';
import { CarPhotoStore } from './car-photo-store';

export const CAR_PHOTOS_ROUTES: Routes = [
	{
		path: '',
		providers: [CarGateway, CarPhotoGateway, CarPhotoStore, CarStore],
		loadComponent: () =>
			import('./car-photos').then(({ CarPhotos }) => CarPhotos),
	},
];
