import type { Routes } from '@angular/router';
import { VOICE_WORKFLOW_PROVIDERS } from '../voice/voice.providers';
import { CarGateway } from './car-gateway';
import { CarStore } from './car-store';
import { CurrentSetupGateway } from './current-setup/current-setup-gateway';
import { CurrentSetupStore } from './current-setup/current-setup-store';

export const CAR_OVERVIEW_ROUTES: Routes = [
	{
		path: '',
		providers: [
			CarGateway,
			CarStore,
			CurrentSetupGateway,
			CurrentSetupStore,
			...VOICE_WORKFLOW_PROVIDERS,
		],
		loadComponent: () =>
			import('./car-overview').then(({ CarOverview }) => CarOverview),
	},
];
