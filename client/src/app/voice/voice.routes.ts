import type { Routes } from '@angular/router';
import { CarGateway } from '../car/car-gateway';
import { CarStore } from '../car/car-store';
import { VOICE_WORKFLOW_PROVIDERS } from './voice.providers';

export const VOICE_ROUTES: Routes = [
	{
		path: '',
		providers: [CarGateway, CarStore, ...VOICE_WORKFLOW_PROVIDERS],
		loadComponent: () =>
			import('./voice-track-log').then(({ VoiceTrackLog }) => VoiceTrackLog),
	},
];
