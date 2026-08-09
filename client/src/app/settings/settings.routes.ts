import { Routes } from '@angular/router';
import { SettingsStore } from './settings-store';
import { TimezoneGateway } from './timezone-gateway';
import { TimezoneStore } from './timezone-store';

export const SETTINGS_ROUTES: Routes = [
	{
		path: '',
		providers: [SettingsStore, TimezoneGateway, TimezoneStore],
		loadComponent: () => import('./settings').then(({ Settings }) => Settings),
	},
];
