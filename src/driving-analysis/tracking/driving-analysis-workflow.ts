import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import { z } from 'zod';
import { DrivingAnalysisAuthority } from '../analysis/driving-analysis-authority';
import {
	type DrivingAnalysisWorkflowPayload,
	drivingAnalysisWorkflowPayloadSchema,
} from '../analysis/driving-analysis-contracts';
import {
	type DrivingAnalysisCreationWorkflowResult,
	DrivingAnalysisCreationWorkflowRunner,
	RealDrivingAnalysisContainerPort,
} from '../analysis/driving-analysis-creation-workflow';
import {
	AcceptedCornerEvidence,
	AcceptedCornerEvidenceError,
} from '../evidence/accepted-corner-evidence';
import { CornerEvidenceAuthority } from '../evidence/corner-evidence-authority';
import {
	GPU_LEASE_COORDINATOR_OBJECT_NAME,
	GPU_MAX_DEADLINE_MS,
	type GpuLeaseAcquireInput,
	type GpuLeaseAcquireResult,
	type GpuLeaseEnqueueInput,
	type GpuLeaseEnqueueResult,
	type GpuLeaseHoldInput,
	type GpuLeaseHoldReleaseInput,
	type GpuLeaseMutationResult,
	type GpuLeaseReleaseInput,
	type GpuLeaseRenewInput,
	type GpuLeaseWitnessInput,
} from '../gpu-lease-coordinator';
import type {
	PublicTrackingProvenance,
	PublicTrackingState,
	TrackingWorkflowIdentity,
} from './authority-contracts';
import {
	type ExecutionIdentity,
	type JobStatus,
	subjectSeedSchema,
	type TrackingJobSubmission,
	uuidV4Schema,
} from './contracts';
import { inferenceProfileSchema } from './inference-profile';
import {
	LocalSam31Provider,
	type TrackingProvider,
} from './local-sam31-provider';
import { PreparedTrackViewAuthority } from './prepared-track-view-authority';
import { preparedTrackViewStore } from './r2-prepared-track-view-store';
import { R2TrackingArtifactStore } from './r2-tracking-artifact-store';
import {
	type R2TransferGrantAuthority,
	r2TransferGrantAuthority,
	TrackingTransferGrantError,
} from './r2-transfer-grant-authority';
import type { TrackViewMediaPreparationPort } from './track-view-preparation';
import {
	type TrackingArtifactPublication,
	TrackingArtifactPublicationError,
	trackingArtifactPublication,
} from './tracking-artifact-publication';
import {
	TrackingAuthority,
	type TrackingWorkflowContext,
} from './tracking-authority';

const STATUS_POLL_INTERVAL = '15 seconds';
const SINGLE_ATTEMPT_STEP = {
	retries: {
		limit: 1,
		delay: 0,
		backoff: 'constant',
	},
	timeout: '30 seconds',
} as const;

const authorityIdentifierSchema = z
	.string()
	.min(1)
	.max(128)
	.refine(
		(value) =>
			![...value].some((character) => {
				const code = character.charCodeAt(0);
				return code < 0x20 || code === 0x7f;
			}),
	);

export const firstTrackingWorkflowPayloadSchema = z.strictObject({
	ownerId: authorityIdentifierSchema,
	analysisId: authorityIdentifierSchema,
	runId: uuidV4Schema,
	segmentId: uuidV4Schema,
	preparedMediaId: uuidV4Schema,
	subjectSeed: subjectSeedSchema,
});

export type FirstTrackingWorkflowPayload = z.infer<
	typeof firstTrackingWorkflowPayloadSchema
>;

export type FirstTrackingWorkflowResult = {
	state: PublicTrackingState;
	provenance: PublicTrackingProvenance;
};

export type TrackingWorkflowErrorCode =
	| 'TRACKING_AUTHORITY_STALE'
	| 'TRACKING_PROVIDER_UNAVAILABLE'
	| 'TRACKING_PROVIDER_FAILED'
	| 'TRACKING_ARTIFACT_INVALID';

export class TrackingWorkflowError extends Error {
	constructor(readonly code: TrackingWorkflowErrorCode) {
		super(code);
		this.name = 'TrackingWorkflowError';
	}
}

class AcceptedEvidenceWorkflowError extends TrackingWorkflowError {}

type CoordinatorPort = {
	enqueue(input: GpuLeaseEnqueueInput): Promise<GpuLeaseEnqueueResult>;
	acquire(input: GpuLeaseAcquireInput): Promise<GpuLeaseAcquireResult>;
	witness(input: GpuLeaseWitnessInput): Promise<GpuLeaseMutationResult>;
	renew(input: GpuLeaseRenewInput): Promise<GpuLeaseMutationResult>;
	release(input: GpuLeaseReleaseInput): Promise<GpuLeaseMutationResult>;
	beginCommitHold(input: GpuLeaseHoldInput): Promise<GpuLeaseMutationResult>;
	releaseCommitHold(
		input: GpuLeaseHoldReleaseInput,
	): Promise<GpuLeaseMutationResult>;
};

export type DrivingAnalysisWorkflowEnvironment = {
	DB: D1Database;
	ANALYSIS_MEDIA: R2Bucket;
	GPU_LEASE_COORDINATOR: {
		getByName(name: string): CoordinatorPort;
	};
	R2_ACCOUNT_ID?: string;
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	GPU_PROVIDER_ORIGIN?: string;
	GPU_ACCESS_CLIENT_ID?: string;
	GPU_ACCESS_CLIENT_SECRET?: string;
	INFERENCE_PROFILE_JSON?: string;
	RACE_VIDEO_MEDIA_CONTAINER?: {
		getByName(name: string): {
			prepareTrackView(command: unknown): Promise<unknown>;
		};
	};
};

export const deployedInferenceProfile = (
	value: string | undefined,
): ReturnType<typeof inferenceProfileSchema.parse> => {
	if (!value)
		throw new Error('INFERENCE_PROFILE_JSON is required for tracking');
	try {
		return inferenceProfileSchema.parse(JSON.parse(value));
	} catch {
		throw new Error('INFERENCE_PROFILE_JSON is invalid');
	}
};

export const raceVideoTrackViewPreparationPort = (
	binding: DrivingAnalysisWorkflowEnvironment['RACE_VIDEO_MEDIA_CONTAINER'],
): TrackViewMediaPreparationPort => ({
	prepare: (command) => {
		const container = binding?.getByName(command.request.caseId);
		if (!container)
			throw new Error('Race-video media container is unavailable');
		return container.prepareTrackView(command);
	},
});

type AttemptIdentity = ExecutionIdentity & {
	ownerId: string;
};

const MUTABLE_ATTEMPT_STATES = [
	'active',
	'transferring',
	'processing',
	'output-ready',
] as const;

export class FirstTrackingSegmentWorkflow {
	constructor(
		private readonly authority: TrackingAuthority,
		private readonly coordinator: CoordinatorPort,
		private readonly provider: TrackingProvider,
		private readonly grants: Pick<R2TransferGrantAuthority, 'issue'>,
		private readonly publication: Pick<TrackingArtifactPublication, 'publish'>,
		private readonly evidence: Pick<AcceptedCornerEvidence, 'commit'>,
		private readonly publishAnalysisState: (
			ownerId: string,
			analysisId: string,
			state: PublicTrackingState,
		) => Promise<void>,
	) {}

	async run(
		event: Readonly<WorkflowEvent<FirstTrackingWorkflowPayload>>,
		step: WorkflowStep,
	): Promise<FirstTrackingWorkflowResult> {
		const payload = firstTrackingWorkflowPayloadSchema.parse(event.payload);
		const timestamp = event.timestamp.getTime();
		if (!Number.isFinite(timestamp))
			throw new TrackingWorkflowError('TRACKING_AUTHORITY_STALE');
		const createdAt = event.timestamp.toISOString();
		const workflowIdentity = {
			ownerId: payload.ownerId,
			analysisId: payload.analysisId,
			runId: payload.runId,
			workflowId: event.instanceId,
			segmentId: payload.segmentId,
		};
		let context = await step.do('create-or-resume-first-segment', async () =>
			this.authority.createFirstSegment({
				...workflowIdentity,
				preparedMediaId: payload.preparedMediaId,
				order: 0,
				seed: {
					kind: 'initial',
					sourceId: null,
					value: payload.subjectSeed,
				},
				specificationVersion: 'tracking-segment-spec.v1',
				availabilityDeadlineAt: timestamp + GPU_MAX_DEADLINE_MS,
				createdAt,
			}),
		);
		if (context.acceptedArtifactId !== null) {
			await this.commitAcceptedEvidence(
				workflowIdentity,
				step,
				'accepted-replay',
			);
			return this.publicResult(workflowIdentity, step, 'accepted-replay');
		}

		let identity = await this.resumeIdentity(context, step);
		if (!identity) {
			identity = await this.acquireAndActivate(
				workflowIdentity,
				context,
				createdAt,
				step,
			);
			context = await step.do('reload-activated-authority', async () =>
				this.authority.workflowContext(workflowIdentity),
			);
		}
		let status: JobStatus;
		try {
			status = await step.do(
				'submit-tracking-segment',
				SINGLE_ATTEMPT_STEP,
				async () => {
					await this.assertProviderAuthority(workflowIdentity, identity);
					const result = await this.provider.submit(
						this.submission(context, identity),
					);
					if (result.ok === false) throw providerFailure(result.code);
					return result.value;
				},
			);
		} catch (error) {
			return this.fail(error, workflowIdentity, identity, step);
		}

		for (let statusIndex = 0; ; statusIndex += 1) {
			try {
				validateWorkflowStatus(status);
				context = await this.synchronizeAuthority(
					workflowIdentity,
					identity,
					status,
					statusIndex,
					step,
				);
				if (status.state === 'completed') {
					const artifact = status.artifact;
					/* c8 ignore next -- validateWorkflowStatus establishes the completed artifact. */
					if (!artifact)
						throw new TrackingWorkflowError('TRACKING_ARTIFACT_INVALID');
					const transferRequestId = context.outputTransferRequestId;
					if (!transferRequestId)
						throw new TrackingWorkflowError('TRACKING_ARTIFACT_INVALID');
					await step.do('accept-first-tracking-evidence', async () => {
						try {
							await this.publication.publish({
								ownerId: payload.ownerId,
								transferRequestId,
								artifact,
							});
						} catch (error) {
							if (
								error instanceof TrackingArtifactPublicationError &&
								error.code === 'STALE_AUTHORITY'
							)
								throw new TrackingWorkflowError('TRACKING_AUTHORITY_STALE');
							throw new TrackingWorkflowError('TRACKING_ARTIFACT_INVALID');
						}
						return { accepted: true };
					});
					await this.commitAcceptedEvidence(workflowIdentity, step, 'accepted');
					return this.publicResult(workflowIdentity, step, 'accepted');
				}

				await this.renew(identity, step, statusIndex);
				if (
					status.state === 'transfer-grant-required' ||
					status.state === 'output-ready'
				) {
					const request = status.transferRequest;
					/* c8 ignore next -- validateWorkflowStatus establishes the transfer request. */
					if (!request)
						throw new TrackingWorkflowError('TRACKING_PROVIDER_FAILED');
					status = await step.do(
						`deliver-${request.role}-grant-${statusIndex}`,
						SINGLE_ATTEMPT_STEP,
						async () => {
							try {
								const grant = await this.grants.issue({
									...identity,
									transferRequestId: request.transferRequestId,
									role: request.role,
									method: request.method,
								});
								const result = await this.provider.deliverTransferGrant(grant);
								if (result.ok === false) throw providerFailure(result.code);
								return result.value;
							} catch (error) {
								if (
									error instanceof TrackingTransferGrantError &&
									error.code === 'LEASE_MISMATCH'
								)
									throw new TrackingWorkflowError('TRACKING_AUTHORITY_STALE');
								throw error;
							}
						},
					);
					continue;
				}

				await step.sleep(
					`wait-for-tracking-status-${statusIndex}`,
					STATUS_POLL_INTERVAL,
				);
				status = await step.do(
					`read-tracking-status-${statusIndex}`,
					SINGLE_ATTEMPT_STEP,
					async () => {
						await this.assertProviderAuthority(workflowIdentity, identity);
						const result = await this.provider.status(
							providerIdentity(identity),
						);
						if (result.ok === false) throw providerFailure(result.code);
						return result.value;
					},
				);
			} catch (error) {
				return this.fail(error, workflowIdentity, identity, step);
			}
		}
	}

	private async resumeIdentity(
		context: TrackingWorkflowContext,
		step: WorkflowStep,
	): Promise<AttemptIdentity | null> {
		const attempt = context.attempt;
		if (
			!attempt ||
			!MUTABLE_ATTEMPT_STATES.includes(
				attempt.state as (typeof MUTABLE_ATTEMPT_STATES)[number],
			)
		)
			return null;
		const identity = attemptIdentity(context, attempt);
		const witness = await step.do('witness-resumed-lease', async () =>
			this.coordinator.witness(leaseIdentity(identity)),
		);
		return witness.status === 'ok' ? identity : null;
	}

	private async acquireAndActivate(
		workflowIdentity: TrackingWorkflowIdentity,
		context: TrackingWorkflowContext,
		createdAt: string,
		step: WorkflowStep,
	): Promise<AttemptIdentity> {
		await step.do('enqueue-first-tracking-segment', async () =>
			this.coordinator.enqueue({
				segmentId: context.segmentId,
				deadlineAt: context.availabilityDeadlineAt,
				kind: 'initial',
			}),
		);
		const lease = await step.do(
			'acquire-first-tracking-lease',
			SINGLE_ATTEMPT_STEP,
			async () => {
				const result = await this.coordinator.acquire({
					segmentId: context.segmentId,
				});
				if (
					result.status !== 'acquired' ||
					result.segmentId !== context.segmentId
				)
					throw new TrackingWorkflowError('TRACKING_PROVIDER_UNAVAILABLE');
				return result;
			},
		);
		const attemptId = await deterministicUuidV4(
			`tracking-attempt:${context.segmentId}:${lease.leaseId}:${lease.fence}`,
		);
		const identity = {
			ownerId: workflowIdentity.ownerId,
			runId: workflowIdentity.runId,
			segmentId: workflowIdentity.segmentId,
			attemptId,
			leaseId: lease.leaseId,
			fencingToken: lease.fence,
			specificationDigest: context.specificationDigest,
			profileDigest: context.profileDigest,
		};
		try {
			await step.do('activate-first-tracking-attempt', async () => {
				await this.authority.activateAttempt({
					ownerId: identity.ownerId,
					runId: identity.runId,
					segmentId: identity.segmentId,
					attemptId: identity.attemptId,
					leaseId: identity.leaseId,
					fence: identity.fencingToken,
					expectedCurrentAttemptId: context.attempt?.attemptId ?? null,
					createdAt,
				});
				return { activated: true };
			});
		} catch {
			await step.do('release-unactivated-tracking-lease', async () =>
				this.coordinator.release(leaseIdentity(identity)),
			);
			throw new TrackingWorkflowError('TRACKING_AUTHORITY_STALE');
		}
		return identity;
	}

	private submission(
		context: TrackingWorkflowContext,
		identity: AttemptIdentity,
	): TrackingJobSubmission {
		return {
			contractVersion: 'tracking-provider.v1',
			...providerIdentity(identity),
			trackingRequest: {
				contractVersion: 'subject-tracking.v1',
				correlationId: identity.attemptId,
				caseId: context.prepared.caseId,
				observationSegmentId: identity.segmentId,
				prepared: context.prepared,
				subjectSeed: context.seed,
			},
		};
	}

	private async assertProviderAuthority(
		workflowIdentity: TrackingWorkflowIdentity,
		identity: AttemptIdentity,
	): Promise<void> {
		const context = await this.authority.workflowContext(workflowIdentity);
		assertCurrentAttempt(context, identity);
		const witness = await this.coordinator.witness(leaseIdentity(identity));
		if (witness.status !== 'ok')
			throw new TrackingWorkflowError('TRACKING_AUTHORITY_STALE');
	}

	private async synchronizeAuthority(
		workflowIdentity: TrackingWorkflowIdentity,
		identity: AttemptIdentity,
		status: JobStatus,
		statusIndex: number,
		step: WorkflowStep,
	): Promise<TrackingWorkflowContext> {
		let context = await step.do(
			`reload-current-authority-for-status-${statusIndex}`,
			async () => this.authority.workflowContext(workflowIdentity),
		);
		assertCurrentAttempt(context, identity);
		const target = targetAttemptState(status);
		const transitions = transitionPath(context.attempt?.state, target);
		for (const [transitionIndex, nextState] of transitions.entries()) {
			context = await step.do(
				`persist-tracking-status-${statusIndex}-${transitionIndex}`,
				async () => {
					const attempt = assertCurrentAttempt(context, identity);
					await this.authority.transitionAttempt({
						ownerId: identity.ownerId,
						runId: identity.runId,
						segmentId: identity.segmentId,
						attemptId: identity.attemptId,
						leaseId: identity.leaseId,
						fence: identity.fencingToken,
						expectedState: attempt.state,
						nextState,
						progress: Math.max(attempt.progress, status.progress),
						safeFailureCode: null,
						updatedAt: new Date().toISOString(),
					});
					return this.authority.workflowContext(workflowIdentity);
				},
			);
		}
		return context;
	}

	private async renew(
		identity: AttemptIdentity,
		step: WorkflowStep,
		statusIndex: number,
	): Promise<void> {
		const renewed = await step.do(
			`renew-tracking-lease-${statusIndex}`,
			async () => this.coordinator.renew(leaseIdentity(identity)),
		);
		if (renewed.status !== 'ok')
			throw new TrackingWorkflowError('TRACKING_AUTHORITY_STALE');
	}

	private async fail(
		error: unknown,
		workflowIdentity: TrackingWorkflowIdentity,
		identity: AttemptIdentity,
		step: WorkflowStep,
	): Promise<never> {
		if (
			(error instanceof TrackingWorkflowError &&
				(error.code === 'TRACKING_AUTHORITY_STALE' ||
					error instanceof AcceptedEvidenceWorkflowError)) ||
			(error instanceof AcceptedCornerEvidenceError &&
				error.code === 'RETRYABLE_INFRASTRUCTURE')
		)
			throw error;
		const code = publicFailure(error);
		try {
			await step.do('record-safe-tracking-failure', async () => {
				const context = await this.authority.workflowContext(workflowIdentity);
				const attempt = assertCurrentAttempt(context, identity);
				await this.authority.transitionAttempt({
					ownerId: identity.ownerId,
					runId: identity.runId,
					segmentId: identity.segmentId,
					attemptId: identity.attemptId,
					leaseId: identity.leaseId,
					fence: identity.fencingToken,
					expectedState: attempt.state,
					nextState: 'failed',
					progress: attempt.progress,
					safeFailureCode: code,
					updatedAt: new Date().toISOString(),
				});
				return { failed: true };
			});
			await step.do('release-failed-tracking-lease', async () =>
				this.coordinator.release(leaseIdentity(identity)),
			);
			const state = await step.do('load-safe-tracking-failure-state', () =>
				this.authority.publicState(
					workflowIdentity.ownerId,
					workflowIdentity.analysisId,
					workflowIdentity.runId,
				),
			);
			await step.do('publish-safe-tracking-failure', async () => {
				await this.publishAnalysisState(
					workflowIdentity.ownerId,
					workflowIdentity.analysisId,
					state,
				);
				return { published: true };
			});
		} catch {
			throw new TrackingWorkflowError('TRACKING_AUTHORITY_STALE');
		}
		throw new TrackingWorkflowError(code);
	}

	private async publicResult(
		workflowIdentity: TrackingWorkflowIdentity,
		step: WorkflowStep,
		name: string,
	): Promise<FirstTrackingWorkflowResult> {
		const result = await step.do(
			`load-public-tracking-result-${name}`,
			async () => ({
				state: await this.authority.publicState(
					workflowIdentity.ownerId,
					workflowIdentity.analysisId,
					workflowIdentity.runId,
				),
				provenance: await this.authority.publicProvenance(
					workflowIdentity.ownerId,
					workflowIdentity.analysisId,
					workflowIdentity.runId,
				),
			}),
		);
		await step.do(`publish-analysis-tracking-state-${name}`, async () => {
			await this.publishAnalysisState(
				workflowIdentity.ownerId,
				workflowIdentity.analysisId,
				result.state,
			);
			return { published: true };
		});
		return result;
	}

	private async commitAcceptedEvidence(
		workflowIdentity: TrackingWorkflowIdentity,
		step: WorkflowStep,
		name: string,
	): Promise<void> {
		await step.do(`commit-accepted-corner-evidence-${name}`, async () => {
			try {
				await this.evidence.commit(workflowIdentity);
			} catch (error) {
				if (
					error instanceof AcceptedCornerEvidenceError &&
					error.code === 'STALE_AUTHORITY'
				)
					throw new TrackingWorkflowError('TRACKING_AUTHORITY_STALE');
				if (
					error instanceof AcceptedCornerEvidenceError &&
					error.code === 'RETRYABLE_INFRASTRUCTURE'
				)
					throw error;
				throw new AcceptedEvidenceWorkflowError('TRACKING_ARTIFACT_INVALID');
			}
			return { committed: true };
		});
	}
}

export const firstTrackingSegmentWorkflow = (
	environment: DrivingAnalysisWorkflowEnvironment,
): FirstTrackingSegmentWorkflow =>
	new FirstTrackingSegmentWorkflow(
		new TrackingAuthority(environment.DB),
		environment.GPU_LEASE_COORDINATOR.getByName(
			GPU_LEASE_COORDINATOR_OBJECT_NAME,
		),
		new LocalSam31Provider({
			origin: environment.GPU_PROVIDER_ORIGIN ?? '',
			accessClientId: environment.GPU_ACCESS_CLIENT_ID ?? '',
			accessClientSecret: environment.GPU_ACCESS_CLIENT_SECRET ?? '',
		}),
		r2TransferGrantAuthority(environment),
		trackingArtifactPublication(environment),
		new AcceptedCornerEvidence(
			new CornerEvidenceAuthority(environment.DB),
			new R2TrackingArtifactStore(environment.ANALYSIS_MEDIA),
		),
		async (ownerId, analysisId, state) => {
			await new DrivingAnalysisAuthority(environment.DB).publishTrackingState(
				ownerId,
				analysisId,
				state,
				new Date().toISOString(),
			);
		},
	);

export class DrivingAnalysisWorkflow extends WorkflowEntrypoint<
	DrivingAnalysisWorkflowEnvironment,
	DrivingAnalysisWorkflowPayload
> {
	async run(
		event: Readonly<WorkflowEvent<DrivingAnalysisWorkflowPayload>>,
		step: WorkflowStep,
	): Promise<DrivingAnalysisCreationWorkflowResult> {
		const payload = drivingAnalysisWorkflowPayloadSchema.parse(event.payload);
		/* c8 ignore next -- real profile/container wiring is exercised by deployment acceptance. */
		const authority = new DrivingAnalysisAuthority(this.env.DB);
		return new DrivingAnalysisCreationWorkflowRunner(
			authority,
			{
				startPreparation: async (command) => {
					return new RealDrivingAnalysisContainerPort({
						authority,
						tracking: new TrackingAuthority(this.env.DB),
						prepared: new PreparedTrackViewAuthority(this.env.DB),
						media: raceVideoTrackViewPreparationPort(
							this.env.RACE_VIDEO_MEDIA_CONTAINER,
						),
						profile: deployedInferenceProfile(this.env.INFERENCE_PROFILE_JSON),
						store: preparedTrackViewStore(this.env),
					}).startPreparation(command);
				},
			},
			undefined,
			async (command) => {
				await firstTrackingSegmentWorkflow(this.env).run(
					{
						...event,
						payload: {
							ownerId: command.ownerId,
							analysisId: command.analysisId,
							runId: command.runId,
							segmentId: command.segmentId,
							preparedMediaId: command.preparedMediaId,
							subjectSeed: command.subjectSeed,
						},
					} as Readonly<WorkflowEvent<FirstTrackingWorkflowPayload>>,
					step,
				);
			},
		).run({ ...event, payload }, step);
	}
}

export const deterministicUuidV4 = async (value: string): Promise<string> => {
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

const attemptIdentity = (
	context: TrackingWorkflowContext,
	attempt: NonNullable<TrackingWorkflowContext['attempt']>,
): AttemptIdentity => ({
	ownerId: context.ownerId,
	runId: context.runId,
	segmentId: context.segmentId,
	attemptId: attempt.attemptId,
	leaseId: attempt.leaseId,
	fencingToken: attempt.fence,
	specificationDigest: context.specificationDigest,
	profileDigest: context.profileDigest,
});

const providerIdentity = (identity: AttemptIdentity): ExecutionIdentity => ({
	runId: identity.runId,
	segmentId: identity.segmentId,
	attemptId: identity.attemptId,
	leaseId: identity.leaseId,
	fencingToken: identity.fencingToken,
	specificationDigest: identity.specificationDigest,
	profileDigest: identity.profileDigest,
});

const leaseIdentity = (identity: AttemptIdentity) => ({
	segmentId: identity.segmentId,
	leaseId: identity.leaseId,
	fence: identity.fencingToken,
});

const assertCurrentAttempt = (
	context: TrackingWorkflowContext,
	identity: AttemptIdentity,
): NonNullable<TrackingWorkflowContext['attempt']> => {
	const attempt = context.attempt;
	if (
		!attempt ||
		context.runId !== identity.runId ||
		context.segmentId !== identity.segmentId ||
		context.profileDigest !== identity.profileDigest ||
		context.specificationDigest !== identity.specificationDigest ||
		attempt.attemptId !== identity.attemptId ||
		attempt.leaseId !== identity.leaseId ||
		attempt.fence !== identity.fencingToken ||
		!MUTABLE_ATTEMPT_STATES.includes(
			attempt.state as (typeof MUTABLE_ATTEMPT_STATES)[number],
		)
	)
		throw new TrackingWorkflowError('TRACKING_AUTHORITY_STALE');
	return attempt;
};

const targetAttemptState = (
	status: JobStatus,
): 'transferring' | 'processing' | 'output-ready' => {
	if (
		status.state === 'transfer-grant-required' ||
		status.state === 'transferring'
	)
		return 'transferring';
	if (status.state === 'processing' || status.state === 'cancel-requested')
		return 'processing';
	/* c8 ignore next 2 -- every remaining valid nonterminal status is output-ready or completed. */
	if (status.state === 'output-ready' || status.state === 'completed')
		return 'output-ready';
	/* c8 ignore next -- terminal states are rejected before attempt-state mapping. */
	throw new TrackingWorkflowError('TRACKING_PROVIDER_FAILED');
};

const transitionPath = (
	current: NonNullable<TrackingWorkflowContext['attempt']>['state'] | undefined,
	target: 'transferring' | 'processing' | 'output-ready',
): readonly ('transferring' | 'processing' | 'output-ready')[] => {
	/* c8 ignore next -- current authority is asserted before path selection. */
	if (!current) throw new TrackingWorkflowError('TRACKING_AUTHORITY_STALE');
	const ranks = {
		active: 0,
		transferring: 1,
		processing: 2,
		'output-ready': 3,
	};
	/* c8 ignore next 2 -- current authority is restricted to the four mutable states above. */
	if (!(current in ranks))
		throw new TrackingWorkflowError('TRACKING_AUTHORITY_STALE');
	const currentRank = ranks[current as keyof typeof ranks];
	const targetRank = ranks[target];
	if (targetRank < currentRank)
		throw new TrackingWorkflowError('TRACKING_PROVIDER_FAILED');
	if (current === target) return [target];
	if (target === 'transferring') return ['transferring'];
	if (target === 'processing') return ['processing'];
	return current === 'processing'
		? ['output-ready']
		: ['processing', 'output-ready'];
};

const validateWorkflowStatus = (status: JobStatus): void => {
	if (
		(status.state === 'transfer-grant-required' &&
			(status.transferRequest === null || status.artifact !== null)) ||
		(status.state === 'output-ready' &&
			(status.transferRequest?.role !== 'observation-artifact' ||
				status.transferRequest.method !== 'PUT' ||
				status.artifact === null)) ||
		(status.state === 'completed' &&
			(status.transferRequest !== null || status.artifact === null)) ||
		(['failed', 'interrupted', 'cancelled'] as const).includes(
			status.state as 'failed' | 'interrupted' | 'cancelled',
		)
	)
		throw new TrackingWorkflowError(
			status.state === 'completed' || status.state === 'output-ready'
				? 'TRACKING_ARTIFACT_INVALID'
				: 'TRACKING_PROVIDER_FAILED',
		);
};

const providerFailure = (code: string): TrackingWorkflowError =>
	new TrackingWorkflowError(
		code === 'TRACKING_PROVIDER_UNAVAILABLE'
			? 'TRACKING_PROVIDER_UNAVAILABLE'
			: 'TRACKING_PROVIDER_FAILED',
	);

const publicFailure = (
	error: unknown,
): NonNullable<PublicTrackingState['safeFailureCode']> => {
	if (error instanceof TrackingWorkflowError) {
		if (error.code === 'TRACKING_PROVIDER_UNAVAILABLE') return error.code;
		if (error.code === 'TRACKING_ARTIFACT_INVALID') return error.code;
	}
	return 'TRACKING_PROVIDER_FAILED';
};
