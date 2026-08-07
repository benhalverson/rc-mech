import { Routes } from '@angular/router';
import { CarStore } from './car/car-store';
import { GarageStore } from './garage/garage-store';
import { ownerSessionCanMatch } from './owner-session.guard';

const loadGarage = () => import('./garage/garage').then(({ Garage }) => Garage);
const loadCarOverview = () =>
	import('./car/car-overview').then(({ CarOverview }) => CarOverview);
const loadCarBuild = () =>
	import('./car/car-build').then(({ CarBuild }) => CarBuild);
const loadCarSetups = () =>
	import('./car/car-setups').then(({ CarSetups }) => CarSetups);
const loadCarPhotos = () =>
	import('./car/car-photos').then(({ CarPhotos }) => CarPhotos);
const loadCarRuns = () =>
	import('./car/car-runs').then(({ CarRuns }) => CarRuns);
const loadSettingsRoutes = () =>
	import('./settings/settings.routes').then(
		({ SETTINGS_ROUTES }) => SETTINGS_ROUTES,
	);
const loadMaintenanceRoutes = () =>
	import('./maintenance/maintenance.routes').then(
		({ MAINTENANCE_ROUTES }) => MAINTENANCE_ROUTES,
	);

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
		loadComponent: loadCarOverview,
		providers: [CarStore],
	},
	{
		path: 'garage/:carId/setups',
		canMatch: [ownerSessionCanMatch],
		loadComponent: loadCarSetups,
		providers: [CarStore],
	},
	{
		path: 'garage/:carId/build',
		canMatch: [ownerSessionCanMatch],
		loadComponent: loadCarBuild,
		providers: [CarStore],
	},
	{
		path: 'garage/:carId/photos',
		canMatch: [ownerSessionCanMatch],
		loadComponent: loadCarPhotos,
		providers: [CarStore],
	},
	{
		path: 'garage/:carId/runs',
		canMatch: [ownerSessionCanMatch],
		loadComponent: loadCarRuns,
		providers: [CarStore],
	},
	{
		path: 'maintenance',
		canMatch: [ownerSessionCanMatch],
		loadChildren: loadMaintenanceRoutes,
	},
	{
		path: 'settings',
		canMatch: [ownerSessionCanMatch],
		loadChildren: loadSettingsRoutes,
	},
	{ path: '**', redirectTo: 'garage' },
];
