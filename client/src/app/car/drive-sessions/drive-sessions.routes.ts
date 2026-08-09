import type { Routes } from '@angular/router';
import { CarStore } from '../car-store';
import { DriveSessionGateway } from './drive-session-gateway';
import { DriveSessionStore } from './drive-session-store';

export const DRIVE_SESSIONS_ROUTES: Routes = [
	{
		path: '',
		providers: [DriveSessionGateway, DriveSessionStore, CarStore],
		loadComponent: () =>
			import('./drive-sessions').then(({ DriveSessions }) => DriveSessions),
	},
];
