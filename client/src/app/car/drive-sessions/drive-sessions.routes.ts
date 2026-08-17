import type { Routes } from '@angular/router';
import { CarGateway } from '../car-gateway';
import { CarStore } from '../car-store';
import { DriveSessionGateway } from './drive-session-gateway';
import { DriveSessionStore } from './drive-session-store';
import { DrivingAnalysisStore } from './driving-analysis/driving-analysis-store';
import { PageVisibilityCapability } from './driving-analysis/page-visibility';
import { RaceRecordingFileCapability } from './driving-analysis/race-recording-file';
import { RaceRecordingGateway } from './driving-analysis/race-recording-gateway';

export const DRIVE_SESSIONS_ROUTES: Routes = [
	{
		path: '',
		providers: [
			CarGateway,
			DriveSessionGateway,
			DriveSessionStore,
			PageVisibilityCapability,
			RaceRecordingFileCapability,
			RaceRecordingGateway,
			DrivingAnalysisStore,
			CarStore,
		],
		loadComponent: () =>
			import('./drive-sessions').then(({ DriveSessions }) => DriveSessions),
	},
];
