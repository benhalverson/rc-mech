import { Routes } from '@angular/router';
import { SettingsStore } from './settings-store';

export const SETTINGS_ROUTES: Routes = [
	{
		path: '',
		providers: [SettingsStore],
		loadComponent: () => import('./settings').then(({ Settings }) => Settings),
	},
];
