import { Routes } from '@angular/router';
import { ConsumableStore } from './consumables/consumable-store';
import { MaintenanceGateway } from './maintenance-gateway';
import { MaintenancePlanStore } from './maintenance-plan-store';
import { ServiceRecordStore } from './service-record-store';

export const MAINTENANCE_ROUTES: Routes = [
	{
		path: '',
		providers: [
			ConsumableStore,
			MaintenanceGateway,
			MaintenancePlanStore,
			ServiceRecordStore,
		],
		loadComponent: () =>
			import('./maintenance-cockpit').then(
				({ MaintenanceCockpit }) => MaintenanceCockpit,
			),
	},
];
