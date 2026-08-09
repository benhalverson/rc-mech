import type { Routes } from '@angular/router';
import { CarStore } from '../car-store';
import { CarSetupsStore } from './car-setups-store';
import { SetupSnapshotStore } from './setup-snapshot-store';

export const CAR_SETUPS_ROUTES: Routes = [
	{
		path: '',
		providers: [CarSetupsStore, CarStore, SetupSnapshotStore],
		loadComponent: () =>
			import('./car-setups').then(({ CarSetups }) => CarSetups),
	},
];
