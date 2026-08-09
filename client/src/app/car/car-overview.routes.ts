import type { Routes } from '@angular/router';
import { CarStore } from './car-store';
import { CurrentSetupGateway } from './current-setup/current-setup-gateway';
import { CurrentSetupStore } from './current-setup/current-setup-store';
import { VOICE_WORKFLOW_PROVIDERS } from '../voice/voice.providers';

export const CAR_OVERVIEW_ROUTES: Routes = [
	{
		path: '',
		providers: [
			CarStore,
			CurrentSetupGateway,
			CurrentSetupStore,
			...VOICE_WORKFLOW_PROVIDERS,
		],
		loadComponent: () =>
			import('./car-overview').then(({ CarOverview }) => CarOverview),
	},
];
