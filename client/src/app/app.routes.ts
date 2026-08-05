import { Routes } from '@angular/router';
import { GarageStore } from './garage/garage-store';
import { ownerSessionCanMatch } from './owner-session.guard';

const loadWorkspace = () =>
	import('./garage-workspace').then(({ GarageWorkspace }) => GarageWorkspace);
const loadGarage = () => import('./garage/garage').then(({ Garage }) => Garage);

export const signInRoute = {
	path: 'sign-in',
	loadComponent: () => import('./sign-in').then(({ SignIn }) => SignIn),
};

export const routes: Routes = [
	{ path: '', pathMatch: 'full', redirectTo: 'garage' },
	signInRoute,
	{
		path: 'garage',
		pathMatch: 'full',
		canMatch: [ownerSessionCanMatch],
		loadComponent: loadGarage,
		providers: [GarageStore],
	},
	{
		path: 'garage/:carId/overview',
		canMatch: [ownerSessionCanMatch],
		loadComponent: loadWorkspace,
		providers: [GarageStore],
	},
	{
		path: 'garage/:carId/setups',
		canMatch: [ownerSessionCanMatch],
		loadComponent: loadWorkspace,
		providers: [GarageStore],
	},
	{
		path: 'garage/:carId/build',
		canMatch: [ownerSessionCanMatch],
		loadComponent: loadWorkspace,
		providers: [GarageStore],
	},
	{
		path: 'garage/:carId/photos',
		canMatch: [ownerSessionCanMatch],
		loadComponent: loadWorkspace,
		providers: [GarageStore],
	},
	{
		path: 'garage/:carId/runs',
		canMatch: [ownerSessionCanMatch],
		loadComponent: loadWorkspace,
		providers: [GarageStore],
	},
	{
		path: 'maintenance',
		canMatch: [ownerSessionCanMatch],
		loadComponent: loadWorkspace,
	},
	{
		path: 'settings',
		canMatch: [ownerSessionCanMatch],
		loadComponent: loadWorkspace,
	},
	{ path: '**', redirectTo: 'garage' },
];
