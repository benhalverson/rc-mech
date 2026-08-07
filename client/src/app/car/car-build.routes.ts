import type { Routes } from '@angular/router';
import { CarBuildStore } from './car-build-store';
import { CarStore } from './car-store';

export const CAR_BUILD_ROUTES: Routes = [
	{
		path: '',
		providers: [CarBuildStore, CarStore],
		loadComponent: () => import('./car-build').then(({ CarBuild }) => CarBuild),
	},
];
