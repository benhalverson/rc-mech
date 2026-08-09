import type { Routes } from '@angular/router';
import { CarBuildGateway } from './car-build-gateway';
import { CarBuildStore } from './car-build-store';
import { CarGateway } from './car-gateway';
import { CarStore } from './car-store';

export const CAR_BUILD_ROUTES: Routes = [
	{
		path: '',
		providers: [CarBuildGateway, CarBuildStore, CarGateway, CarStore],
		loadComponent: () => import('./car-build').then(({ CarBuild }) => CarBuild),
	},
];
