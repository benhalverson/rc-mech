import type { Routes } from '@angular/router';
import { CarStore } from './car-store';
import { CurrentSetupGateway } from './current-setup/current-setup-gateway';
import { CurrentSetupStore } from './current-setup/current-setup-store';

export const CAR_OVERVIEW_ROUTES: Routes = [
	{
		path: '',
		providers: [CarStore, CurrentSetupGateway, CurrentSetupStore],
		loadComponent: () =>
			import('./car-overview').then(({ CarOverview }) => CarOverview),
	},
];
