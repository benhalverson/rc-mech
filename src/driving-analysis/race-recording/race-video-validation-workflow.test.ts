import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import type { RaceVideoValidationAuthority } from './race-video-validation-authority';
import {
	RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
	type RaceVideoValidationResponse,
	type RaceVideoValidationWorkflowPayload,
} from './race-video-validation-contracts';
import {
	RaceVideoValidationWorkflow,
	type RaceVideoValidationWorkflowEnvironment,
	RaceVideoValidationWorkflowRunner,
} from './race-video-validation-workflow';

const RECORDING_ID = '11111111-1111-4111-8111-111111111111';
const payload: RaceVideoValidationWorkflowPayload = {
	ownerId: 'owner-1',
	recordingId: RECORDING_ID,
	validationId: RECORDING_ID,
	expectedStateVersion: 1,
};
const event = {
	payload,
	instanceId: RECORDING_ID,
	timestamp: new Date('2026-08-17T10:00:00.000Z'),
} as Readonly<WorkflowEvent<RaceVideoValidationWorkflowPayload>>;
const response: RaceVideoValidationResponse = {
	contractVersion: RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
	correlationId: RECORDING_ID,
	outcome: 'rejected',
	error: {
		code: 'CORRUPT_MEDIA',
		stage: 'probe',
		message: 'The recording is corrupt.',
	},
};

class StepFixture {
	readonly names: string[] = [];
	readonly configurations = new Map<string, unknown>();

	async do<T>(
		name: string,
		callbackOrConfiguration: (() => Promise<T>) | unknown,
		configuredCallback?: () => Promise<T>,
	): Promise<T> {
		this.names.push(name);
		const callback =
			typeof callbackOrConfiguration === 'function'
				? callbackOrConfiguration
				: configuredCallback;
		if (typeof callbackOrConfiguration !== 'function')
			this.configurations.set(name, callbackOrConfiguration);
		if (!callback) throw new Error('Missing step callback');
		return callback();
	}
}

const fixture = (kind: 'pending' | 'stale' | 'terminal' = 'pending') => {
	const context = vi.fn(async () =>
		kind === 'pending'
			? {
					kind: 'pending' as const,
					ownerId: 'owner-1',
					recordingId: RECORDING_ID,
					validationId: RECORDING_ID,
					stateVersion: 1,
					objectKey: `race-recordings/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/${RECORDING_ID}`,
					expectedByteCount: 3,
				}
			: kind === 'terminal'
				? { kind: 'terminal' as const, status: 'ready' as const }
				: { kind: 'stale' as const },
	);
	const publish = vi.fn(async () => 'published' as const);
	const authority = {
		context,
		publish,
	} as unknown as RaceVideoValidationAuthority;
	const validateRaceVideo = vi.fn(async () => response);
	const getByName = vi.fn(() => ({ validateRaceVideo }));
	const steps = new StepFixture();
	return {
		runner: new RaceVideoValidationWorkflowRunner(
			authority,
			{ getByName },
			() => new Date('2026-08-17T10:01:00.000Z'),
		),
		context,
		publish,
		validateRaceVideo,
		getByName,
		steps,
	};
};

describe('Race-video validation Workflow', () => {
	test('uses one named container invocation and publishes a fenced result', async () => {
		const value = fixture();
		await expect(
			value.runner.run(event, value.steps as unknown as WorkflowStep),
		).resolves.toEqual({ status: 'published' });
		expect(value.steps.names).toEqual([
			'load-race-video-validation',
			'validate-private-race-video',
			'publish-race-video-validation',
		]);
		expect(
			value.steps.configurations.get('validate-private-race-video'),
		).toEqual({
			retries: { limit: 2, delay: '5 seconds', backoff: 'constant' },
			timeout: '20 minutes',
		});
		expect(value.getByName).toHaveBeenCalledWith(RECORDING_ID);
		expect(value.validateRaceVideo).toHaveBeenCalledWith({
			recordingId: RECORDING_ID,
			validationId: RECORDING_ID,
			objectKey: expect.stringContaining(`/${RECORDING_ID}`),
			expectedByteCount: 3,
		});
		expect(value.publish).toHaveBeenCalledWith(
			payload,
			response,
			'2026-08-17T10:01:00.000Z',
		);
	});

	test('turns container failures into one stable public-safe result', async () => {
		const value = fixture();
		value.validateRaceVideo.mockRejectedValueOnce(new Error('private detail'));
		await expect(
			value.runner.run(event, value.steps as unknown as WorkflowStep),
		).resolves.toEqual({ status: 'published' });
		expect(value.publish).toHaveBeenCalledWith(
			payload,
			{
				contractVersion: RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
				correlationId: RECORDING_ID,
				outcome: 'rejected',
				error: {
					code: 'SERVICE_UNAVAILABLE',
					stage: 'admission',
					message: 'The media validation service is temporarily unavailable.',
				},
			},
			'2026-08-17T10:01:00.000Z',
		);
	});

	test('makes stale and terminal replays no-ops', async () => {
		for (const [kind, status] of [
			['stale', 'stale'],
			['terminal', 'replayed'],
		] as const) {
			const value = fixture(kind);
			await expect(
				value.runner.run(event, value.steps as unknown as WorkflowStep),
			).resolves.toEqual({ status });
			expect(value.validateRaceVideo).not.toHaveBeenCalled();
			expect(value.publish).not.toHaveBeenCalled();
		}
	});

	test('rejects malformed internal payloads before authority access', async () => {
		const value = fixture();
		await expect(
			value.runner.run(
				{ ...event, payload: { ...payload, recordingId: 'unsafe' } },
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toThrow();
		expect(value.context).not.toHaveBeenCalled();
	});

	test('entrypoint composes its D1 authority and configured namespace', async () => {
		const authorityPrototype = (
			await import('./race-video-validation-authority')
		).RaceVideoValidationAuthority.prototype;
		const context = vi
			.spyOn(authorityPrototype, 'context')
			.mockResolvedValue({ kind: 'terminal', status: 'invalid' });
		const publish = vi
			.spyOn(authorityPrototype, 'publish')
			.mockResolvedValue('published');
		const validateRaceVideo = vi.fn(async () => response);
		const environment = {
			DB: {} as D1Database,
			RACE_VIDEO_MEDIA_CONTAINER: {
				getByName: vi.fn(() => ({ validateRaceVideo })),
			},
		} as unknown as RaceVideoValidationWorkflowEnvironment;
		const workflow = new RaceVideoValidationWorkflow(
			{} as ExecutionContext,
			environment,
		);
		await expect(
			workflow.run(event, new StepFixture() as unknown as WorkflowStep),
		).resolves.toEqual({ status: 'replayed' });
		expect(context).toHaveBeenCalledWith(payload);
		context.mockResolvedValueOnce({
			kind: 'pending',
			ownerId: 'owner-1',
			recordingId: RECORDING_ID,
			validationId: RECORDING_ID,
			stateVersion: 1,
			objectKey: `race-recordings/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/${RECORDING_ID}`,
			expectedByteCount: 3,
		});
		await expect(
			workflow.run(event, new StepFixture() as unknown as WorkflowStep),
		).resolves.toEqual({ status: 'published' });
		expect(validateRaceVideo).toHaveBeenCalledOnce();
		expect(publish).toHaveBeenCalledWith(payload, response, expect.any(String));
		context.mockRestore();
		publish.mockRestore();
	});
});
