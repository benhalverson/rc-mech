import { inject } from '@angular/core';
import { Router, type Routes } from '@angular/router';
import { ownerSessionCanMatch } from './owner-session.guard';

const loadGarageRoutes = () =>
	import('./garage/garage.routes').then(({ GARAGE_ROUTES }) => GARAGE_ROUTES);
const loadCarOverviewRoutes = () =>
	import('./car/car-overview.routes').then(
		({ CAR_OVERVIEW_ROUTES }) => CAR_OVERVIEW_ROUTES,
	);
const loadCarBuildRoutes = () =>
	import('./car/car-build.routes').then(
		({ CAR_BUILD_ROUTES }) => CAR_BUILD_ROUTES,
	);
const loadCarSetupsRoutes = () =>
	import('./car/car-setups.routes').then(
		({ CAR_SETUPS_ROUTES }) => CAR_SETUPS_ROUTES,
	);
const loadCarPhotosRoutes = () =>
	import('./car/car-photos.routes').then(
		({ CAR_PHOTOS_ROUTES }) => CAR_PHOTOS_ROUTES,
	);
const loadDriveSessionRoutes = () =>
	import('./car/drive-sessions/drive-sessions.routes').then(
		({ DRIVE_SESSIONS_ROUTES }) => DRIVE_SESSIONS_ROUTES,
	);
const loadVoiceRoutes = () =>
	import('./voice/voice.routes').then(({ VOICE_ROUTES }) => VOICE_ROUTES);
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
		loadChildren: loadGarageRoutes,
	},
	{
		path: 'garage/:carId/overview',
		canMatch: [ownerSessionCanMatch],
		loadChildren: loadCarOverviewRoutes,
	},
	{
		path: 'garage/:carId/setups',
		canMatch: [ownerSessionCanMatch],
		loadChildren: loadCarSetupsRoutes,
	},
	{
		path: 'garage/:carId/build',
		canMatch: [ownerSessionCanMatch],
		loadChildren: loadCarBuildRoutes,
	},
	{
		path: 'garage/:carId/photos',
		canMatch: [ownerSessionCanMatch],
		loadChildren: loadCarPhotosRoutes,
	},
	{
		path: 'garage/:carId/drive-sessions',
		canMatch: [ownerSessionCanMatch],
		loadChildren: loadDriveSessionRoutes,
	},
	{
		path: 'garage/:carId/runs',
		pathMatch: 'full',
		redirectTo: ({ params, queryParams, fragment }) =>
			inject(Router).createUrlTree(
				['/garage', params['carId'], 'drive-sessions'],
				{ queryParams, fragment: fragment ?? undefined },
			),
	},
	{
		path: 'garage/:carId/voice',
		canMatch: [ownerSessionCanMatch],
		loadChildren: loadVoiceRoutes,
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
