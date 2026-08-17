import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import type { DrivingAnalysisAuthority } from './driving-analysis-authority';
import {
	type DrivingAnalysisWorkflowPayload,
	drivingAnalysisWorkflowPayloadSchema,
	type PublicDrivingAnalysis,
} from './driving-analysis-contracts';

const FAKE_PREPARATION_STEP = {
	retries: { limit: 2, delay: '5 seconds', backoff: 'constant' },
	timeout: '1 minute',
} as const;

const fakePreparationResultSchema = z.strictObject({
	progress: z.number().int().min(1).max(99),
});

export type DrivingAnalysisPreparationCommand = Pick<
	PublicDrivingAnalysis,
	| 'id'
	| 'raceVideoId'
	| 'raceWindow'
	| 'subjectSeed'
	| 'sourceLayout'
	| 'approvedTrackMapVersionId'
>;

export type DrivingAnalysisContainerPort = {
	startPreparation(
		command: Readonly<{
			analysisId: string;
			raceVideoId: string;
			raceWindow: PublicDrivingAnalysis['raceWindow'];
			subjectSeed: PublicDrivingAnalysis['subjectSeed'];
			sourceLayout: PublicDrivingAnalysis['sourceLayout'];
			approvedTrackMapVersionId: string;
		}>,
	): Promise<{ progress: number }>;
};

export class FakeDrivingAnalysisContainerPort
	implements DrivingAnalysisContainerPort
{
	async startPreparation(): Promise<{ progress: number }> {
		return { progress: 15 };
	}
}

export type DrivingAnalysisCreationWorkflowResult =
	| Readonly<{
			status: 'published' | 'replayed';
			analysis: PublicDrivingAnalysis;
	  }>
	| Readonly<{ status: 'stale' }>;

export class DrivingAnalysisCreationWorkflowRunner {
	constructor(
		private readonly authority: DrivingAnalysisAuthority,
		private readonly container: DrivingAnalysisContainerPort,
		private readonly clock: () => Date = () => new Date(),
	) {}

	async run(
		event: Readonly<WorkflowEvent<DrivingAnalysisWorkflowPayload>>,
		step: WorkflowStep,
	): Promise<DrivingAnalysisCreationWorkflowResult> {
		const payload = drivingAnalysisWorkflowPayloadSchema.parse(event.payload);
		const begun = await step.do(
			'begin-driving-analysis-preparation',
			async () =>
				this.authority.beginPreparation(
					payload,
					event.instanceId,
					this.clock().toISOString(),
				),
		);
		if (begun.kind === 'stale') return { status: 'stale' };
		if (begun.kind === 'replayed' && begun.analysis.progress > 0)
			return { status: 'replayed', analysis: begun.analysis };

		const analysis = begun.analysis;
		const preparation = fakePreparationResultSchema.parse(
			await step.do(
				'start-fake-driving-analysis-preparation',
				FAKE_PREPARATION_STEP,
				async () =>
					this.container.startPreparation({
						analysisId: analysis.id,
						raceVideoId: analysis.raceVideoId,
						raceWindow: analysis.raceWindow,
						subjectSeed: analysis.subjectSeed,
						sourceLayout: analysis.sourceLayout,
						approvedTrackMapVersionId: analysis.approvedTrackMapVersionId,
					}),
			),
		);
		const published = await step.do(
			'publish-driving-analysis-preparation-progress',
			async () =>
				this.authority.publishPreparationProgress(
					{
						...payload,
						expectedStateVersion: analysis.stateVersion,
					},
					event.instanceId,
					preparation.progress,
					this.clock().toISOString(),
				),
		);
		if (published.kind === 'stale') return { status: 'stale' };
		return { status: published.kind, analysis: published.analysis };
	}
}
