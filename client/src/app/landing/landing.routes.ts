import type { Routes } from '@angular/router';

export const LANDING_ROUTES: Routes = [
	{
		path: '',
		loadComponent: () => import('./landing').then(({ Landing }) => Landing),
	},
];
