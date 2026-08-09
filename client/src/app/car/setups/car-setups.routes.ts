import type { Routes } from '@angular/router';
import { GarageGateway } from '../../garage/garage-gateway';
import { CarGateway } from '../car-gateway';
import { CarStore } from '../car-store';
import { CarSetupsStore } from './car-setups-store';
import { SetupSnapshotGateway, SoDialedImportGateway } from './setup-snapshot';
import { SetupSnapshotStore } from './setup-snapshot-store';

export const CAR_SETUPS_ROUTES: Routes = [
	{
		path: '',
		providers: [
			CarGateway,
			GarageGateway,
			CarSetupsStore,
			CarStore,
			SetupSnapshotGateway,
			SetupSnapshotStore,
			SoDialedImportGateway,
		],
		loadComponent: () =>
			import('./car-setups').then(({ CarSetups }) => CarSetups),
	},
];
