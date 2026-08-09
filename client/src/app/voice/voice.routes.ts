import type { Routes } from '@angular/router';
import { CarStore } from '../car/car-store';
import {
	DRIVE_SESSION_CONTEXT,
	DriveSessionContextStore,
} from '../car/drive-sessions/drive-session-context';
import { DriveSessionGateway } from '../car/drive-sessions/drive-session-gateway';
import { VoiceLogStore } from './voice-log-store';

export const VOICE_ROUTES: Routes = [
	{
		path: '',
		providers: [
			CarStore,
			DriveSessionGateway,
			DriveSessionContextStore,
			{
				provide: DRIVE_SESSION_CONTEXT,
				useExisting: DriveSessionContextStore,
			},
			VoiceLogStore,
		],
		loadComponent: () =>
			import('./voice-track-log').then(({ VoiceTrackLog }) => VoiceTrackLog),
	},
];
