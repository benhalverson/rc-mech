import { createAuth } from './auth';
import { DrivingAnalysisAuthority } from './driving-analysis/analysis/driving-analysis-authority';
import type { DrivingAnalysisWorkflowPayload } from './driving-analysis/analysis/driving-analysis-contracts';
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
	drivingAnalysisAuthority(env: Env): DrivingAnalysisAuthority;
};

export const startDrivingAnalysisCreation = async (
	workflow: Env['DRIVING_ANALYSIS_WORKFLOW'],
	payload: DrivingAnalysisWorkflowPayload,
): Promise<void> => {
	try {
		const created = await workflow.createBatch([
			{ id: payload.workflowId, params: payload },
		]);
		if (created.some((instance) => instance.id === payload.workflowId)) return;
	} catch {
		// A deterministic instance may already exist; inspect it below.
	}
	try {
		const existing = await workflow.get(payload.workflowId);
		const status = await existing.status();
		if (status.status === 'errored' || status.status === 'terminated')
			await existing.restart();
		else if (status.status === 'unknown')
			throw new Error('Driving-analysis creation Workflow is unavailable');
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === 'Driving-analysis creation Workflow is unavailable'
		)
			throw error;
		throw new Error('Driving-analysis creation Workflow is unavailable');
	}
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
	drivingAnalysisAuthority: (env) =>
		new DrivingAnalysisAuthority(env.DB, {
			startProcessing: (payload) =>
				startDrivingAnalysisCreation(env.DRIVING_ANALYSIS_WORKFLOW, payload),
		}),
};
