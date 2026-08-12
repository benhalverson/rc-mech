import { createAuth } from './auth';
import {
	type Issue230RoundTripCommand,
	type Issue230RoundTripResult,
	runIssue230ContainerRoundTrip,
} from './issue-230-container';
import {
	createWorkersAiVoiceProcessor,
	type VoiceProcessor,
} from './voice-processing';

type AuthSession = { user: { id: string } };

export type AppDependencies = {
	getSession(env: Env, headers: Headers): Promise<AuthSession | null>;
	handleAuth(env: Env, request: Request): Promise<Response>;
	containerRoundTrip(
		env: Env,
		command: Issue230RoundTripCommand,
	): Promise<Issue230RoundTripResult>;
	voiceProcessor(env: Env): VoiceProcessor;
};

export const defaultAppDependencies: AppDependencies = {
	getSession: async (env, headers) =>
		createAuth(env).api.getSession({ headers }),
	handleAuth: (env, request) => createAuth(env).handler(request),
	containerRoundTrip: runIssue230ContainerRoundTrip,
	voiceProcessor: (env) => createWorkersAiVoiceProcessor(env),
};
