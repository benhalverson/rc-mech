import type { Routes } from '@angular/router';
import { GarageGateway } from './garage-gateway';
import { GarageStore } from './garage-store';

export const GARAGE_ROUTES: Routes = [
	{
		path: '',
		providers: [GarageGateway, GarageStore],
		loadComponent: () => import('./garage').then(({ Garage }) => Garage),
	},
];
