import { createAuth } from './auth';
import { RaceRecordingAuthority } from './driving-analysis/race-recording/race-recording-authority';
import {
	createWorkersAiVoiceProcessor,
	type VoiceProcessor,
} from './voice-processing';

type AuthSession = { user: { id: string } };

export type AppDependencies = {
	getSession(env: Env, headers: Headers): Promise<AuthSession | null>;
	handleAuth(env: Env, request: Request): Promise<Response>;
	voiceProcessor(env: Env): VoiceProcessor;
	raceRecordingAuthority(env: Env): RaceRecordingAuthority;
};

export const defaultAppDependencies: AppDependencies = {
	getSession: async (env, headers) =>
		createAuth(env).api.getSession({ headers }),
	handleAuth: (env, request) => createAuth(env).handler(request),
	voiceProcessor: (env) => createWorkersAiVoiceProcessor(env),
	raceRecordingAuthority: (env) =>
		new RaceRecordingAuthority(env.DB, env.ANALYSIS_MEDIA),
};
