import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import {
	DrivingAnalysisWorkflow,
	type DrivingAnalysisWorkflowEnvironment,
} from '../tracking/driving-analysis-workflow';
import { DrivingAnalysisAuthority } from './driving-analysis-authority';
import type { DrivingAnalysisWorkflowPayload } from './driving-analysis-contracts';
import {
	type DrivingAnalysisContainerPort,
	DrivingAnalysisCreationWorkflowRunner,
	FakeDrivingAnalysisContainerPort,
} from './driving-analysis-creation-workflow';

const ANALYSIS_ID = '66666666-6666-4666-8666-666666666666';
const payload: DrivingAnalysisWorkflowPayload = {
	kind: 'analysis-creation.v1',
	ownerId: 'owner-1',
	analysisId: ANALYSIS_ID,
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
	raceVideoId: '33333333-3333-4333-8333-333333333333',
	approvedTrackMapVersionId: '44444444-4444-4444-8444-444444444444',
	raceWindow: { startTimestampMs: 120_000, endTimestampMs: 720_000 },
	subjectSeed: {
		timestampMs: 180_000,
		box: { x: 0.25, y: 0.4, width: 0.08, height: 0.06 },
	},
	sourceLayout: {
		version: 'fixed-track-view.v1' as const,
		digest: 'a'.repeat(64),
		width: 1920,
		height: 1080,
		trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
	},
	status: 'running' as const,
	stage: 'preparation' as const,
	progress,
	stateVersion,
});

describe('Driving-analysis creation Workflow', () => {
	test('advances only through authoritative D1 publications around the fake port', async () => {
		const beginPreparation = vi.fn(async () => ({
			kind: 'published' as const,
			analysis: analysis(2, 0),
		}));
		const publishPreparationProgress = vi.fn(async () => ({
			kind: 'published' as const,
			analysis: analysis(3, 15),
		}));
		const authority = {
			beginPreparation,
			publishPreparationProgress,
		} as unknown as DrivingAnalysisAuthority;
		const startPreparation = vi.fn(async () => ({ progress: 15 }));
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
			analysis: analysis(3, 15),
		});
		expect(steps.names).toEqual([
			'begin-driving-analysis-preparation',
			'start-fake-driving-analysis-preparation',
			'publish-driving-analysis-preparation-progress',
		]);
		expect(
			steps.configurations.get('start-fake-driving-analysis-preparation'),
		).toEqual({
			retries: { limit: 2, delay: '5 seconds', backoff: 'constant' },
			timeout: '1 minute',
		});
		expect(startPreparation).toHaveBeenCalledWith({
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
			15,
			'2026-08-17T18:00:01.000Z',
		);
	});

	test('makes stale and completed replayed D1 starts no-ops before the port', async () => {
		for (const begun of [
			{ kind: 'stale' as const },
			{ kind: 'replayed' as const, analysis: analysis(3, 15) },
		]) {
			const beginPreparation = vi.fn(async () => begun);
			const authority = {
				beginPreparation,
			} as unknown as DrivingAnalysisAuthority;
			const startPreparation = vi.fn(async () => ({ progress: 15 }));
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
			analysis: analysis(3, 15),
		}));
		const startPreparation = vi.fn(async () => ({ progress: 15 }));
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
			analysis: { progress: 15 },
		});
		expect(startPreparation).toHaveBeenCalledOnce();
	});

	test('returns authoritative stale and replayed publication outcomes', async () => {
		for (const published of [
			{ kind: 'stale' as const },
			{ kind: 'replayed' as const, analysis: analysis(3, 15) },
		]) {
			const authority = {
				beginPreparation: vi.fn(async () => ({
					kind: 'published' as const,
					analysis: analysis(2, 0),
				})),
				publishPreparationProgress: vi.fn(async () => published),
			} as unknown as DrivingAnalysisAuthority;
			const runner = new DrivingAnalysisCreationWorkflowRunner(authority, {
				startPreparation: vi.fn(async () => ({ progress: 15 })),
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
			startPreparation: vi.fn(async () => ({ progress: 15 })),
		});
		await expect(
			runner.run(
				{ ...event, payload: { ...payload, analysisId: 'unsafe' } },
				new StepFixture() as unknown as WorkflowStep,
			),
		).rejects.toThrow();
		expect(beginPreparation).not.toHaveBeenCalled();
	});

	test('provides the default fake preparation port', async () => {
		await expect(
			new FakeDrivingAnalysisContainerPort().startPreparation(),
		).resolves.toEqual({ progress: 15 });
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
});
