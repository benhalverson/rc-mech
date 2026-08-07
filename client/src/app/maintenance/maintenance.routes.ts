import { Routes } from '@angular/router';
import { MaintenanceStore } from './maintenance-store';

export const MAINTENANCE_ROUTES: Routes = [
	{
		path: '',
		providers: [MaintenanceStore],
		loadComponent: () =>
			import('./maintenance').then(({ Maintenance }) => Maintenance),
	},
];
