import { describe, expect, test, vi } from 'vitest';
import {
	defaultAppDependencies,
	startDrivingAnalysisWorkflow,
	startRaceVideoValidation,
} from './app-dependencies';
import type { DrivingAnalysisWorkflowPayload } from './driving-analysis/analysis/driving-analysis-contracts';
import type { RaceVideoValidationWorkflowPayload } from './driving-analysis/race-recording/race-video-validation-contracts';

const payload = {
	ownerId: 'owner-1',
	recordingId: '11111111-1111-4111-8111-111111111111',
	validationId: '11111111-1111-4111-8111-111111111111',
	expectedStateVersion: 1,
};
const analysisPayload: DrivingAnalysisWorkflowPayload = {
	kind: 'analysis-creation.v1',
	ownerId: 'owner-1',
	analysisId: '22222222-2222-4222-8222-222222222222',
	workflowId: '22222222-2222-4222-8222-222222222222',
	workflowSequence: 1,
	expectedStateVersion: 1,
};

const workflow = (
	status: string,
	createFailure = true,
	createdId?: string,
	getFailure = false,
) => {
	const restart = vi.fn(async () => undefined);
	const instance = {
		terminate: vi.fn(async () => undefined),
		status: vi.fn(async () => ({ status })),
		restart,
	};
	const createBatch = createFailure
		? vi.fn(async () => {
				throw new Error('duplicate');
			})
		: vi.fn(async () => (createdId ? [{ id: createdId }] : []));
	const get = getFailure
		? vi.fn(async () => {
				throw new Error('missing');
			})
		: vi.fn(async () => instance);
	return {
		binding: {
			createBatch,
			get,
		} as unknown as Env['RACE_VIDEO_VALIDATION_WORKFLOW'],
		createBatch,
		get,
		instance,
		restart,
	};
};

describe('Race-video validation Workflow starter', () => {
	test('creates one deterministic instance', async () => {
		const value = workflow('queued', false);
		await expect(
			startRaceVideoValidation(value.binding, payload),
		).resolves.toBeUndefined();
		expect(value.createBatch).toHaveBeenCalledWith([
			{ id: payload.validationId, params: payload },
		]);
		expect(value.get).not.toHaveBeenCalled();
	});

	test('accepts a live replay and restarts failed durable instances', async () => {
		for (const status of [
			'queued',
			'running',
			'paused',
			'complete',
			'waiting',
			'waitingForPause',
		]) {
			const value = workflow(status);
			await expect(
				startRaceVideoValidation(value.binding, payload),
			).resolves.toBeUndefined();
			expect(value.get).toHaveBeenCalledWith(payload.validationId);
			expect(value.restart).not.toHaveBeenCalled();
		}
		for (const status of ['errored', 'terminated']) {
			const value = workflow(status);
			await expect(
				startRaceVideoValidation(value.binding, payload),
			).resolves.toBeUndefined();
			expect(value.restart).toHaveBeenCalledOnce();
		}
	});

	test('does not silently accept an unknown instance', async () => {
		const value = workflow('unknown');
		await expect(
			startRaceVideoValidation(value.binding, payload),
		).rejects.toThrow('Workflow is unavailable');
	});

	test('production authority delegates validation starts to its environment binding', async () => {
		const value = workflow('queued', false);
		const authority = defaultAppDependencies.raceRecordingAuthority({
			DB: {} as D1Database,
			ANALYSIS_MEDIA: {} as R2Bucket,
			RACE_VIDEO_VALIDATION_WORKFLOW: value.binding,
		} as Env);
		const injected = authority as unknown as {
			startValidation(value: RaceVideoValidationWorkflowPayload): Promise<void>;
		};
		await injected.startValidation(payload);
		expect(value.createBatch).toHaveBeenCalledWith([
			{ id: payload.validationId, params: payload },
		]);
	});
});

describe('Driving-analysis Workflow starter', () => {
	test('starts deterministic cancellation cleanup then terminates the fenced original', async () => {
		const cancellation = { ...analysisPayload, cancellation: true as const };
		const value = workflow(
			'queued',
			false,
			`${analysisPayload.workflowId}-cancel`,
		);
		const authority = defaultAppDependencies.drivingAnalysisAuthority({
			DB: {} as D1Database,
			DRIVING_ANALYSIS_WORKFLOW: value.binding,
		} as unknown as Env);
		const injected = authority as unknown as {
			startProcessing(payload: DrivingAnalysisWorkflowPayload): Promise<void>;
		};
		await injected.startProcessing(cancellation);
		expect(value.createBatch).toHaveBeenCalledWith([
			{ id: `${analysisPayload.workflowId}-cancel`, params: cancellation },
		]);
		expect(value.get).toHaveBeenCalledWith(analysisPayload.workflowId);
		expect(value.instance.terminate).toHaveBeenCalledOnce();
		value.get.mockRejectedValueOnce(new Error('instance.not_found'));
		await expect(
			injected.startProcessing(cancellation),
		).resolves.toBeUndefined();
		value.get.mockRejectedValueOnce(new Error('network unavailable'));
		await expect(injected.startProcessing(cancellation)).rejects.toThrow(
			'network unavailable',
		);
		value.get.mockRejectedValueOnce('unavailable');
		await expect(injected.startProcessing(cancellation)).rejects.toBe(
			'unavailable',
		);
		value.instance.terminate.mockRejectedValue(new Error('already stopped'));
		value.instance.status.mockResolvedValue({ status: 'terminated' });
		await injected.startProcessing(cancellation);
		value.instance.status.mockResolvedValue({ status: 'running' });
		await expect(injected.startProcessing(cancellation)).rejects.toThrow(
			'already stopped',
		);
	});
	test('creates, accepts live replay, restarts failures, and rejects unknown state', async () => {
		let value = workflow('queued', false, analysisPayload.analysisId);
		await expect(
			startDrivingAnalysisWorkflow(
				value.binding as unknown as Env['DRIVING_ANALYSIS_WORKFLOW'],
				analysisPayload,
			),
		).resolves.toBeUndefined();
		expect(value.createBatch).toHaveBeenCalledWith([
			{ id: analysisPayload.analysisId, params: analysisPayload },
		]);
		expect(value.get).not.toHaveBeenCalled();
		value = workflow('queued', false);
		await expect(
			startDrivingAnalysisWorkflow(
				value.binding as unknown as Env['DRIVING_ANALYSIS_WORKFLOW'],
				analysisPayload,
			),
		).resolves.toBeUndefined();
		expect(value.get).toHaveBeenCalledWith(analysisPayload.analysisId);
		for (const status of ['queued', 'running', 'complete']) {
			value = workflow(status);
			await expect(
				startDrivingAnalysisWorkflow(
					value.binding as unknown as Env['DRIVING_ANALYSIS_WORKFLOW'],
					analysisPayload,
				),
			).resolves.toBeUndefined();
			expect(value.restart).not.toHaveBeenCalled();
		}
		for (const status of ['errored', 'terminated']) {
			value = workflow(status);
			await expect(
				startDrivingAnalysisWorkflow(
					value.binding as unknown as Env['DRIVING_ANALYSIS_WORKFLOW'],
					analysisPayload,
				),
			).resolves.toBeUndefined();
			expect(value.restart).toHaveBeenCalledOnce();
		}
		value = workflow('unknown');
		await expect(
			startDrivingAnalysisWorkflow(
				value.binding as unknown as Env['DRIVING_ANALYSIS_WORKFLOW'],
				analysisPayload,
			),
		).rejects.toThrow('Workflow is unavailable');
		value = workflow('queued', true, undefined, true);
		await expect(
			startDrivingAnalysisWorkflow(
				value.binding as unknown as Env['DRIVING_ANALYSIS_WORKFLOW'],
				analysisPayload,
			),
		).rejects.toThrow('Workflow is unavailable');
	});

	test('production authority delegates creation starts to its environment binding', async () => {
		const value = workflow('queued', false, analysisPayload.analysisId);
		const authority = defaultAppDependencies.drivingAnalysisAuthority({
			DB: {} as D1Database,
			DRIVING_ANALYSIS_WORKFLOW:
				value.binding as unknown as Env['DRIVING_ANALYSIS_WORKFLOW'],
		} as Env);
		const injected = authority as unknown as {
			startProcessing(value: DrivingAnalysisWorkflowPayload): Promise<void>;
		};
		await injected.startProcessing(analysisPayload);
		expect(value.createBatch).toHaveBeenCalledWith([
			{ id: analysisPayload.analysisId, params: analysisPayload },
		]);
	});
});
