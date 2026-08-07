import type { Routes } from '@angular/router';
import { GarageStore } from './garage-store';

export const GARAGE_ROUTES: Routes = [
	{
		path: '',
		providers: [GarageStore],
		loadComponent: () => import('./garage').then(({ Garage }) => Garage),
	},
];
