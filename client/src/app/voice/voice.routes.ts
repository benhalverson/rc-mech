import type { Routes } from '@angular/router';
import { CarRunsStore } from '../car/car-runs-store';
import { CarStore } from '../car/car-store';
import { VoiceLogStore } from './voice-log-store';

export const VOICE_ROUTES: Routes = [
	{
		path: '',
		providers: [CarRunsStore, CarStore, VoiceLogStore],
		loadComponent: () =>
			import('./voice-track-log').then(({ VoiceTrackLog }) => VoiceTrackLog),
	},
];
