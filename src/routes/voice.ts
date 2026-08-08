import { Hono } from 'hono';
import type { AppDependencies } from '../app-dependencies';
import type { AppEnv } from '../types';
import { createVoiceCaptureRoutes } from './voice/voice-capture';
import { createVoiceConfirmationRoutes } from './voice/voice-confirmation';
import { createVoiceProcessingRoutes } from './voice/voice-processing';

export const createVoiceRoutes = (dependencies: AppDependencies) =>
	new Hono<AppEnv>()
		.route('/', createVoiceCaptureRoutes())
		.route('/', createVoiceProcessingRoutes(dependencies))
		.route('/', createVoiceConfirmationRoutes());
