import type { Provider } from '@angular/core';
import {
	DRIVE_SESSION_CONTEXT,
	DriveSessionContextStore,
} from '../car/drive-sessions/drive-session-context';
import { DriveSessionGateway } from '../car/drive-sessions/drive-session-gateway';
import { VoiceConnectivity } from './voice-connectivity';
import { VoiceGateway } from './voice-gateway';
import { VoiceLogStore } from './voice-log-store';
import { VoiceRecorder } from './voice-recorder';

export const VOICE_WORKFLOW_PROVIDERS: Provider[] = [
	DriveSessionGateway,
	DriveSessionContextStore,
	{
		provide: DRIVE_SESSION_CONTEXT,
		useExisting: DriveSessionContextStore,
	},
	VoiceConnectivity,
	VoiceGateway,
	VoiceLogStore,
	VoiceRecorder,
];
