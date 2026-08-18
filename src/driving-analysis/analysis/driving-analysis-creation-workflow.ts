import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import type { InferenceProfile } from '../tracking/inference-profile';
import { PreparedTrackViewAuthority } from '../tracking/prepared-track-view-authority';
import { preparedTrackViewStore } from '../tracking/r2-prepared-track-view-store';
import type { TrackingRunInput } from '../tracking/track-view-contracts';
import {
	type TrackViewMediaPreparationPort,
	TrackViewPreparation,
} from '../tracking/track-view-preparation';
import { TrackingAuthority } from '../tracking/tracking-authority';
import { digestTrackingRunInput } from '../tracking/tracking-run-input';
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

const preparationResultSchema = z.strictObject({
	progress: z.number().int().min(1).max(99),
	runId: z.string().uuid().optional(),
	preparedMediaId: z.string().uuid().optional(),
});

/* c8 ignore next -- deterministic identity is exercised by the deployed Workflow. */
const deterministicUuidV4 = async (value: string): Promise<string> => {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
	);
	digest[6] = ((digest[6] as number) & 0x0f) | 0x40;
	digest[8] = ((digest[8] as number) & 0x3f) | 0x80;
	const hex = [...digest.subarray(0, 16)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

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
			ownerId: string;
			workflowId: string;
			analysisId: string;
			raceVideoId: string;
			raceWindow: PublicDrivingAnalysis['raceWindow'];
			subjectSeed: PublicDrivingAnalysis['subjectSeed'];
			sourceLayout: PublicDrivingAnalysis['sourceLayout'];
			approvedTrackMapVersionId: string;
		}>,
	): Promise<{
		progress: number;
		runId?: string;
		preparedMediaId?: string;
	}>;
};

type RealPreparationDependencies = Readonly<{
	authority: DrivingAnalysisAuthority;
	tracking: TrackingAuthority;
	prepared: PreparedTrackViewAuthority;
	media: TrackViewMediaPreparationPort;
	profile: InferenceProfile;
	store: ReturnType<typeof preparedTrackViewStore>;
	clock?: () => Date;
}>;

/* c8 ignore start -- exercised through the deployed Workflow/media boundary. */
export class RealDrivingAnalysisContainerPort
	implements DrivingAnalysisContainerPort
{
	private readonly clock;

	constructor(private readonly dependencies: RealPreparationDependencies) {
		this.clock = dependencies.clock ?? (() => new Date());
	}

	async startPreparation(command: {
		ownerId: string;
		workflowId: string;
		analysisId: string;
		raceVideoId: string;
		raceWindow: PublicDrivingAnalysis['raceWindow'];
		subjectSeed: PublicDrivingAnalysis['subjectSeed'];
		sourceLayout: PublicDrivingAnalysis['sourceLayout'];
		approvedTrackMapVersionId: string;
	}): Promise<{
		progress: number;
		runId: string;
		preparedMediaId: string;
	}> {
		const source = await this.dependencies.authority.preparationSource(
			command.ownerId,
			command.analysisId,
		);
		const workflowId = command.workflowId;
		const runId = await deterministicUuidV4(
			`${command.analysisId}:tracking-run:${command.workflowId}`,
		);
		const input: TrackingRunInput = {
			contractVersion: 'tracking-run-input.v1',
			runId,
			raceVideoId: command.raceVideoId,
			sourceObjectKey: source.objectKey,
			sourceByteCount: source.byteCount,
			sourceChecksumSha256: source.checksumSha256,
			window: command.raceWindow,
			approvedTrackMapVersionId: command.approvedTrackMapVersionId,
			sourceLayout: command.sourceLayout,
		};
		const inputDigest = await digestTrackingRunInput(input);
		const createdAt = this.clock().toISOString();
		await this.dependencies.tracking.createRun({
			runId,
			analysisId: command.analysisId,
			ownerId: command.ownerId,
			sequence: 1,
			workflowId,
			profile: this.dependencies.profile,
			inputDigest,
			createdAt,
		});
		await this.dependencies.prepared.pinRunInput({
			ownerId: command.ownerId,
			input,
			createdAt,
		});
		const result = await new TrackViewPreparation({
			authority: this.dependencies.prepared,
			media: this.dependencies.media,
			store: this.dependencies.store,
			now: this.clock,
		}).prepare(command.ownerId, runId);
		return {
			progress: 20,
			runId,
			preparedMediaId: result.prepared.preparedMediaId,
		};
	}
}
/* c8 ignore end */

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
		const preparation = preparationResultSchema.parse(
			await step.do(
				'prepare-driving-analysis-track-view',
				FAKE_PREPARATION_STEP,
				async () =>
					this.container.startPreparation({
						ownerId: payload.ownerId,
						workflowId: event.instanceId,
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
