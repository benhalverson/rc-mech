import { Routes } from '@angular/router';
import { MaintenanceLookups } from './maintenance-lookups';
import { MaintenanceStore } from './maintenance-store';

export const MAINTENANCE_ROUTES: Routes = [
	{
		path: '',
		providers: [MaintenanceLookups, MaintenanceStore],
		loadComponent: () =>
			import('./maintenance-cockpit').then(
				({ MaintenanceCockpit }) => MaintenanceCockpit,
			),
	},
];
