import { createAuth } from './auth';
import { RaceRecordingAuthority } from './driving-analysis/race-recording/race-recording-authority';
import type { RaceVideoValidationWorkflowPayload } from './driving-analysis/race-recording/race-video-validation-contracts';
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

export const startRaceVideoValidation = async (
	workflow: Env['RACE_VIDEO_VALIDATION_WORKFLOW'],
	payload: RaceVideoValidationWorkflowPayload,
): Promise<void> => {
	try {
		await workflow.createBatch([{ id: payload.validationId, params: payload }]);
		return;
	} catch {
		const existing = await workflow.get(payload.validationId);
		const status = await existing.status();
		if (status.status === 'errored' || status.status === 'terminated')
			await existing.restart();
		else if (status.status === 'unknown')
			throw new Error('Race-video validation Workflow is unavailable');
	}
};

export const defaultAppDependencies: AppDependencies = {
	getSession: async (env, headers) =>
		createAuth(env).api.getSession({ headers }),
	handleAuth: (env, request) => createAuth(env).handler(request),
	voiceProcessor: (env) => createWorkersAiVoiceProcessor(env),
	raceRecordingAuthority: (env) =>
		new RaceRecordingAuthority(env.DB, env.ANALYSIS_MEDIA, {
			startValidation: (payload) =>
				startRaceVideoValidation(env.RACE_VIDEO_VALIDATION_WORKFLOW, payload),
		}),
};
