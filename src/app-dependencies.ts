import { createAuth } from './auth';
import { createAnalysisLifecycle } from './driving-analysis/analysis/analysis-lifecycle';
import { DrivingAnalysisAuthority } from './driving-analysis/analysis/driving-analysis-authority';
import type { DrivingAnalysisWorkflowPayload } from './driving-analysis/analysis/driving-analysis-contracts';
import { RaceRecordingAuthority } from './driving-analysis/race-recording/race-recording-authority';
import type { RaceVideoValidationWorkflowPayload } from './driving-analysis/race-recording/race-video-validation-contracts';
import { subjectFrames } from './driving-analysis/race-recording/subject-frames';
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
	analysisLifecycle(env: Env): ReturnType<typeof createAnalysisLifecycle>;
};

export const startDrivingAnalysisWorkflow = async (
	workflow: Env['DRIVING_ANALYSIS_WORKFLOW'],
	payload: DrivingAnalysisWorkflowPayload,
): Promise<void> => {
	const instanceId = payload.cancellation
		? `${payload.workflowId}-cancel`
		: payload.workflowId;
	try {
		const created = await workflow.createBatch([
			{ id: instanceId, params: payload },
		]);
		if (created.some((instance) => instance.id === instanceId)) return;
	} catch {
		// A deterministic instance may already exist; inspect it below.
	}
	try {
		const existing = await workflow.get(instanceId);
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
	analysisLifecycle: (env) =>
		createAnalysisLifecycle({
			binding: env.DB,
			bucket: env.ANALYSIS_MEDIA,
			startCancellation: (payload) => dispatchDrivingAnalysis(env, payload),
		}),
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
			verifySubjectFrame: (command) => subjectFrames(env).verify(command),
			startProcessing: (payload) => dispatchDrivingAnalysis(env, payload),
		}),
};

async function dispatchDrivingAnalysis(
	env: Env,
	payload: DrivingAnalysisWorkflowPayload,
): Promise<void> {
	await startDrivingAnalysisWorkflow(env.DRIVING_ANALYSIS_WORKFLOW, payload);
	if (payload.cancellation) {
		const original = await env.DRIVING_ANALYSIS_WORKFLOW.get(
			payload.workflowId,
		);
		try {
			await original.terminate();
		} catch (error) {
			const { status } = await original.status();
			if (!['errored', 'terminated', 'complete'].includes(status)) throw error;
		}
	}
}
