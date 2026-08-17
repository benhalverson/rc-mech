import { describe, expect, test, vi } from 'vitest';
import {
	defaultAppDependencies,
	startRaceVideoValidation,
} from './app-dependencies';
import type { RaceVideoValidationWorkflowPayload } from './driving-analysis/race-recording/race-video-validation-contracts';

const payload = {
	ownerId: 'owner-1',
	recordingId: '11111111-1111-4111-8111-111111111111',
	validationId: '11111111-1111-4111-8111-111111111111',
	expectedStateVersion: 1,
};

const workflow = (status: string, createFailure = true) => {
	const restart = vi.fn(async () => undefined);
	const instance = {
		status: vi.fn(async () => ({ status })),
		restart,
	};
	const createBatch = createFailure
		? vi.fn(async () => {
				throw new Error('duplicate');
			})
		: vi.fn(async () => []);
	const get = vi.fn(async () => instance);
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
