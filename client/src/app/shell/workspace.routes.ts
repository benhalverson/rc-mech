import { inject } from '@angular/core';
import { type Route, Router, type Routes } from '@angular/router';
import { ownerSessionCanMatch } from '../owner-session.guard';

const loadGarageRoutes = () =>
	import('../garage/garage.routes').then(({ GARAGE_ROUTES }) => GARAGE_ROUTES);
const loadCarOverviewRoutes = () =>
	import('../car/car-overview.routes').then(
		({ CAR_OVERVIEW_ROUTES }) => CAR_OVERVIEW_ROUTES,
	);
const loadCarBuildRoutes = () =>
	import('../car/car-build.routes').then(
		({ CAR_BUILD_ROUTES }) => CAR_BUILD_ROUTES,
	);
const loadCarSetupsRoutes = () =>
	import('../car/setups/car-setups.routes').then(
		({ CAR_SETUPS_ROUTES }) => CAR_SETUPS_ROUTES,
	);
const loadCarPhotosRoutes = () =>
	import('../car/photos/car-photos.routes').then(
		({ CAR_PHOTOS_ROUTES }) => CAR_PHOTOS_ROUTES,
	);
const loadDriveSessionRoutes = () =>
	import('../car/drive-sessions/drive-sessions.routes').then(
		({ DRIVE_SESSIONS_ROUTES }) => DRIVE_SESSIONS_ROUTES,
	);
const loadVoiceRoutes = () =>
	import('../voice/voice.routes').then(({ VOICE_ROUTES }) => VOICE_ROUTES);
const loadSettingsRoutes = () =>
	import('../settings/settings.routes').then(
		({ SETTINGS_ROUTES }) => SETTINGS_ROUTES,
	);
const loadMaintenanceRoutes = () =>
	import('../maintenance/maintenance.routes').then(
		({ MAINTENANCE_ROUTES }) => MAINTENANCE_ROUTES,
	);
const loadTrackMapRoutes = () =>
	import('../track-maps/track-maps.routes').then(
		({ TRACK_MAP_ROUTES }) => TRACK_MAP_ROUTES,
	);
const loadWorkspaceShell = () =>
	import('./workspace-shell').then(({ WorkspaceShell }) => WorkspaceShell);

export const workspaceRoutes: Routes = [
	{
		path: 'garage',
		pathMatch: 'full',
		loadChildren: loadGarageRoutes,
	},
	{
		path: 'garage/:carId/overview',
		loadChildren: loadCarOverviewRoutes,
	},
	{
		path: 'garage/:carId/setups',
		loadChildren: loadCarSetupsRoutes,
	},
	{
		path: 'garage/:carId/build',
		loadChildren: loadCarBuildRoutes,
	},
	{
		path: 'garage/:carId/photos',
		loadChildren: loadCarPhotosRoutes,
	},
	{
		path: 'garage/:carId/drive-sessions',
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
		loadChildren: loadVoiceRoutes,
	},
	{
		path: 'maintenance',
		loadChildren: loadMaintenanceRoutes,
	},
	{
		path: 'settings',
		loadChildren: loadSettingsRoutes,
	},
	{
		path: 'track-maps',
		loadChildren: loadTrackMapRoutes,
	},
];

export const protectedWorkspaceRoute: Route = {
	path: '',
	canMatch: [ownerSessionCanMatch],
	loadComponent: loadWorkspaceShell,
	children: workspaceRoutes,
};

export const WORKSPACE_ROUTES: Routes = [protectedWorkspaceRoute];
