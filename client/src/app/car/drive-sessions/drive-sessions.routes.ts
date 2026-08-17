import type { Routes } from '@angular/router';
import { TrackMapGateway } from '../../track-maps/track-map-gateway';
import { CarGateway } from '../car-gateway';
import { CarStore } from '../car-store';
import { DriveSessionGateway } from './drive-session-gateway';
import { DriveSessionStore } from './drive-session-store';
import { DrivingAnalysisGateway } from './driving-analysis/driving-analysis-gateway';
import { DrivingAnalysisRequestIdentityCapability } from './driving-analysis/driving-analysis-request-identity';
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
			DrivingAnalysisGateway,
			DrivingAnalysisRequestIdentityCapability,
			TrackMapGateway,
			DrivingAnalysisStore,
			CarStore,
		],
		loadComponent: () =>
			import('./drive-sessions').then(({ DriveSessions }) => DriveSessions),
	},
];
