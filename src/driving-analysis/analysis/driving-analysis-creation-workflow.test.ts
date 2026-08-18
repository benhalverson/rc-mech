import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { inferenceProfileFixture } from '../../testing/driving-analysis-tracking-fixtures';
import {
	DrivingAnalysisWorkflow,
	type DrivingAnalysisWorkflowEnvironment,
	FirstTrackingSegmentWorkflow,
} from '../tracking/driving-analysis-workflow';
import { DrivingAnalysisAuthority } from './driving-analysis-authority';
import {
	type DrivingAnalysisWorkflowPayload,
	FIXED_TRACK_VIEW,
} from './driving-analysis-contracts';
import {
	type DrivingAnalysisContainerPort,
	DrivingAnalysisCreationWorkflowRunner,
	RealDrivingAnalysisContainerPort,
} from './driving-analysis-creation-workflow';

const ANALYSIS_ID = '66666666-6666-4666-8666-666666666666';
const payload: DrivingAnalysisWorkflowPayload = {
	kind: 'analysis-creation.v1',
	ownerId: 'owner-1',
	analysisId: ANALYSIS_ID,
	workflowId: ANALYSIS_ID,
	workflowSequence: 1,
	expectedStateVersion: 1,
};
const event = {
	payload,
	instanceId: ANALYSIS_ID,
	timestamp: new Date('2026-08-17T18:00:00.000Z'),
} as Readonly<WorkflowEvent<DrivingAnalysisWorkflowPayload>>;

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

const analysis = (stateVersion: number, progress: number) => ({
	id: ANALYSIS_ID,
	requestId: '55555555-5555-4555-8555-555555555555',
	carId: '11111111-1111-4111-8111-111111111111',
	driveSessionId: '22222222-2222-4222-8222-222222222222',
	raceVideoId: '33333333-3333-4333-8333-333333333333',
	approvedTrackMapVersionId: '44444444-4444-4444-8444-444444444444',
	raceWindow: { startTimestampMs: 120_000, endTimestampMs: 720_000 },
	subjectSeed: {
		timestampMs: 180_000,
		frameIndex: 1800,
		identity: 'subject-1',
		box: { x: 0.25, y: 0.4, width: 0.08, height: 0.06 },
	},
	sourceLayout: {
		version: 'fixed-track-view.v1' as const,
		digest: 'a'.repeat(64),
		width: 1920,
		height: 1080,
		trackView: FIXED_TRACK_VIEW,
	},
	lifecycle: 'preparation' as const,
	status: 'running' as const,
	stage: 'preparation' as const,
	progress,
	stateVersion,
	createdAt: '2026-08-17T18:00:00.000Z',
	updatedAt: '2026-08-17T18:00:00.000Z',
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Driving-analysis creation Workflow', () => {
	test('advances only through authoritative D1 publications around preparation', async () => {
		const beginPreparation = vi.fn(async () => ({
			kind: 'published' as const,
			analysis: analysis(2, 0),
		}));
		const publishPreparationProgress = vi.fn(async () => ({
			kind: 'published' as const,
			analysis: analysis(3, 20),
		}));
		const authority = {
			beginPreparation,
			publishPreparationProgress,
		} as unknown as DrivingAnalysisAuthority;
		const startPreparation = vi.fn(async () => ({ progress: 20 }));
		const port: DrivingAnalysisContainerPort = { startPreparation };
		const runner = new DrivingAnalysisCreationWorkflowRunner(
			authority,
			port,
			() => new Date('2026-08-17T18:00:01.000Z'),
		);
		const steps = new StepFixture();

		await expect(
			runner.run(event, steps as unknown as WorkflowStep),
		).resolves.toEqual({
			status: 'published',
			analysis: analysis(3, 20),
		});
		expect(steps.names).toEqual([
			'begin-driving-analysis-preparation',
			'prepare-driving-analysis-track-view',
			'publish-driving-analysis-preparation-progress',
		]);
		expect(
			steps.configurations.get('prepare-driving-analysis-track-view'),
		).toEqual({
			retries: { limit: 2, delay: '5 seconds', backoff: 'constant' },
			timeout: '30 minutes',
		});
		expect(startPreparation).toHaveBeenCalledWith({
			ownerId: 'owner-1',
			workflowId: ANALYSIS_ID,
			workflowSequence: 1,
			createdAt: '2026-08-17T18:00:00.000Z',
			analysisId: ANALYSIS_ID,
			raceVideoId: analysis(2, 0).raceVideoId,
			raceWindow: analysis(2, 0).raceWindow,
			subjectSeed: analysis(2, 0).subjectSeed,
			sourceLayout: analysis(2, 0).sourceLayout,
			approvedTrackMapVersionId: analysis(2, 0).approvedTrackMapVersionId,
		});
		expect(publishPreparationProgress).toHaveBeenCalledWith(
			{ ...payload, expectedStateVersion: 2 },
			ANALYSIS_ID,
			20,
			'2026-08-17T18:00:01.000Z',
		);
	});

	test('makes stale and completed replayed D1 starts no-ops before the port', async () => {
		for (const begun of [
			{ kind: 'stale' as const },
			{ kind: 'replayed' as const, analysis: analysis(3, 20) },
		]) {
			const beginPreparation = vi.fn(async () => begun);
			const authority = {
				beginPreparation,
			} as unknown as DrivingAnalysisAuthority;
			const startPreparation = vi.fn(async () => ({ progress: 20 }));
			const runner = new DrivingAnalysisCreationWorkflowRunner(authority, {
				startPreparation,
			});
			await expect(
				runner.run(event, new StepFixture() as unknown as WorkflowStep),
			).resolves.toEqual(
				begun.kind === 'stale'
					? { status: 'stale' }
					: { status: 'replayed', analysis: begun.analysis },
			);
			expect(startPreparation).not.toHaveBeenCalled();
		}
	});

	test('continues a replayed zero-progress preparation from authoritative state', async () => {
		const beginPreparation = vi.fn(async () => ({
			kind: 'replayed' as const,
			analysis: analysis(2, 0),
		}));
		const publishPreparationProgress = vi.fn(async () => ({
			kind: 'published' as const,
			analysis: analysis(3, 20),
		}));
		const startPreparation = vi.fn(async () => ({ progress: 20 }));
		const runner = new DrivingAnalysisCreationWorkflowRunner(
			{
				beginPreparation,
				publishPreparationProgress,
			} as unknown as DrivingAnalysisAuthority,
			{ startPreparation },
		);

		await expect(
			runner.run(event, new StepFixture() as unknown as WorkflowStep),
		).resolves.toMatchObject({
			status: 'published',
			analysis: { progress: 20 },
		});
		expect(startPreparation).toHaveBeenCalledOnce();
	});

	test('returns authoritative stale and replayed publication outcomes', async () => {
		for (const published of [
			{ kind: 'stale' as const },
			{ kind: 'replayed' as const, analysis: analysis(3, 20) },
		]) {
			const authority = {
				beginPreparation: vi.fn(async () => ({
					kind: 'published' as const,
					analysis: analysis(2, 0),
				})),
				publishPreparationProgress: vi.fn(async () => published),
			} as unknown as DrivingAnalysisAuthority;
			const runner = new DrivingAnalysisCreationWorkflowRunner(authority, {
				startPreparation: vi.fn(async () => ({ progress: 20 })),
			});
			await expect(
				runner.run(event, new StepFixture() as unknown as WorkflowStep),
			).resolves.toEqual(
				published.kind === 'stale'
					? { status: 'stale' }
					: { status: 'replayed', analysis: published.analysis },
			);
		}
	});

	test('publishes a failed lifecycle when preparation cannot complete', async () => {
		const publishWorkflowFailure = vi.fn(async () => ({
			kind: 'published' as const,
			analysis: { ...analysis(3, 0), status: 'failed' as const },
		}));
		const runner = new DrivingAnalysisCreationWorkflowRunner(
			{
				beginPreparation: vi.fn(async () => ({
					kind: 'published' as const,
					analysis: analysis(2, 0),
				})),
				publishWorkflowFailure,
			} as unknown as DrivingAnalysisAuthority,
			{
				startPreparation: vi.fn(async () => {
					throw new Error('private preparation detail');
				}),
			},
			() => new Date('2026-08-17T18:00:01.000Z'),
		);
		await expect(
			runner.run(event, new StepFixture() as unknown as WorkflowStep),
		).rejects.toThrow('private preparation detail');
		expect(publishWorkflowFailure).toHaveBeenCalledWith(
			payload,
			ANALYSIS_ID,
			'2026-08-17T18:00:01.000Z',
		);
	});

	test('rejects malformed payloads and fake-port progress before D1 publication', async () => {
		const beginPreparation = vi.fn(async () => ({
			kind: 'published' as const,
			analysis: analysis(2, 0),
		}));
		const publishPreparationProgress = vi.fn();
		const authority = {
			beginPreparation,
			publishPreparationProgress,
		} as unknown as DrivingAnalysisAuthority;
		let runner = new DrivingAnalysisCreationWorkflowRunner(authority, {
			startPreparation: vi.fn(async () => ({ progress: 100 })),
		});
		await expect(
			runner.run(event, new StepFixture() as unknown as WorkflowStep),
		).rejects.toThrow();
		expect(publishPreparationProgress).not.toHaveBeenCalled();

		beginPreparation.mockClear();
		runner = new DrivingAnalysisCreationWorkflowRunner(authority, {
			startPreparation: vi.fn(async () => ({ progress: 20 })),
		});
		await expect(
			runner.run(
				{ ...event, payload: { ...payload, analysisId: 'unsafe' } },
				new StepFixture() as unknown as WorkflowStep,
			),
		).rejects.toThrow();
		expect(beginPreparation).not.toHaveBeenCalled();
	});

	test('dispatches creation through the one per-analysis Workflow entrypoint', async () => {
		const begin = vi
			.spyOn(DrivingAnalysisAuthority.prototype, 'beginPreparation')
			.mockResolvedValue({ kind: 'stale' });
		const environment = {
			DB: {} as D1Database,
		} as DrivingAnalysisWorkflowEnvironment;
		const workflow = new DrivingAnalysisWorkflow(
			{} as ExecutionContext,
			environment,
		);
		await expect(
			workflow.run(event, new StepFixture() as unknown as WorkflowStep),
		).resolves.toEqual({ status: 'stale' });
		expect(begin).toHaveBeenCalledWith(
			payload,
			ANALYSIS_ID,
			expect.any(String),
		);
	});

	test('keeps preparation and first Tracking segment in the same run Workflow', async () => {
		const begin = vi
			.spyOn(DrivingAnalysisAuthority.prototype, 'beginPreparation')
			.mockResolvedValue({ kind: 'published', analysis: analysis(2, 0) });
		vi.spyOn(
			DrivingAnalysisAuthority.prototype,
			'publishPreparationProgress',
		).mockResolvedValue({ kind: 'published', analysis: analysis(3, 20) });
		vi.spyOn(
			DrivingAnalysisAuthority.prototype,
			'publishTrackingStart',
		).mockResolvedValue({
			kind: 'published',
			analysis: {
				...analysis(4, 21),
				lifecycle: 'tracking',
				stage: 'tracking',
			},
		});
		const runId = '11111111-1111-4111-8111-111111111111';
		const preparedMediaId = '22222222-2222-4222-8222-222222222222';
		const prepare = vi
			.spyOn(RealDrivingAnalysisContainerPort.prototype, 'startPreparation')
			.mockResolvedValue({ progress: 20, runId, preparedMediaId });
		const runFirst = vi
			.spyOn(FirstTrackingSegmentWorkflow.prototype, 'run')
			.mockResolvedValue({
				state: {
					runId,
					lifecycle: 'running',
					stage: 'tracking',
					progress: 99,
					waitReason: null,
					safeFailureCode: null,
				},
				provenance: { runId, profileDigest: 'a'.repeat(64), segments: [] },
			});
		const environment = {
			DB: {} as D1Database,
			ANALYSIS_MEDIA: {} as R2Bucket,
			GPU_LEASE_COORDINATOR: { getByName: () => ({}) },
			GPU_PROVIDER_ORIGIN: 'https://gpu.chassisnotes.com',
			GPU_ACCESS_CLIENT_ID: 'client-id',
			GPU_ACCESS_CLIENT_SECRET: 'client-secret',
			R2_ACCOUNT_ID: 'a'.repeat(32),
			R2_ACCESS_KEY_ID: 'access-key',
			R2_SECRET_ACCESS_KEY: 'secret-key',
			INFERENCE_PROFILE_JSON: JSON.stringify(inferenceProfileFixture()),
		} as unknown as DrivingAnalysisWorkflowEnvironment;
		const workflow = new DrivingAnalysisWorkflow(
			{} as ExecutionContext,
			environment,
		);
		await expect(
			workflow.run(event, new StepFixture() as unknown as WorkflowStep),
		).resolves.toMatchObject({ analysis: { stage: 'tracking', progress: 21 } });
		expect(begin).toHaveBeenCalledOnce();
		expect(prepare).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowId: ANALYSIS_ID,
				workflowSequence: 1,
			}),
		);
		expect(runFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				instanceId: ANALYSIS_ID,
				payload: expect.objectContaining({ runId, preparedMediaId }),
			}),
			expect.anything(),
		);
	});
});
