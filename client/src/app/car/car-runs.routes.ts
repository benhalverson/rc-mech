import type { Routes } from '@angular/router';
import { CarRunsStore } from './car-runs-store';
import { CarStore } from './car-store';

export const CAR_RUNS_ROUTES: Routes = [
	{
		path: '',
		providers: [CarRunsStore, CarStore],
		loadComponent: () => import('./car-runs').then(({ CarRuns }) => CarRuns),
	},
];
