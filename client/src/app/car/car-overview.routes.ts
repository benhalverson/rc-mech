import type { Routes } from '@angular/router';
import { CarStore } from './car-store';

export const CAR_OVERVIEW_ROUTES: Routes = [
	{
		path: '',
		providers: [CarStore],
		loadComponent: () =>
			import('./car-overview').then(({ CarOverview }) => CarOverview),
	},
];
