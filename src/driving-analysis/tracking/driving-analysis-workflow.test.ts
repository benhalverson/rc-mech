import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	ATTEMPT_ID,
	inferenceProfileFixture,
	jobStatusFixture,
	LEASE_ID,
	PROFILE_DIGEST,
	RUN_ID,
	SEGMENT_ID,
	submissionFixture,
} from '../../testing/driving-analysis-tracking-fixtures';
import { MockR2Controller } from '../../testing/hono-fixture';
import {
	preparedDescriptorFixture,
	preparedObjectsFixture,
	trackingRunInputFixture,
} from '../../testing/prepared-track-view-fixtures';
import { createSqliteD1, type SqliteD1Fixture } from '../../testing/sqlite-d1';
import { DrivingAnalysisAuthority } from '../analysis/driving-analysis-authority';
import {
	AcceptedCornerEvidence,
	AcceptedCornerEvidenceError,
} from '../evidence/accepted-corner-evidence';
import type {
	GpuLeaseAcquireInput,
	GpuLeaseAcquireResult,
	GpuLeaseBusyInput,
	GpuLeaseEnqueueInput,
	GpuLeaseEnqueueResult,
	GpuLeaseHoldInput,
	GpuLeaseHoldReleaseInput,
	GpuLeaseMutationResult,
	GpuLeaseReleaseInput,
	GpuLeaseRenewInput,
	GpuLeaseWitnessInput,
} from '../gpu-lease-coordinator';
import { gpuLeaseEnqueueInput } from '../gpu-lease-coordinator';
import type {
	PublicTrackingProvenance,
	PublicTrackingState,
} from './authority-contracts';
import type {
	ExecutionIdentity,
	JobStatus,
	OutputArtifact,
	SubjectProvenance,
	TrackingJobSubmission,
	TransferGrantCommand,
} from './contracts';
import {
	type DrivingAnalysisWorkflowEnvironment,
	deployedInferenceProfile,
	deterministicJitter,
	deterministicUuidV4,
	FirstTrackingSegmentWorkflow,
	type FirstTrackingWorkflowPayload,
	firstTrackingSegmentWorkflow,
	raceVideoTrackViewPreparationPort,
	TrackingWorkflowError,
} from './driving-analysis-workflow';
import { inferenceProfileSchema } from './inference-profile';
import type { TrackingProvider } from './local-sam31-provider';
import { PreparedTrackViewAuthority } from './prepared-track-view-authority';
import { TrackingTransferGrantError } from './r2-transfer-grant-authority';
import {
	stagingArtifactObjectKey,
	subjectProvenanceForProfile,
	TrackingArtifactPublicationError,
	trackingInputDigestFor,
} from './tracking-artifact-publication';
import {
	TrackingAuthority,
	type TrackingWorkflowContext,
} from './tracking-authority';

const OWNER_ID = 'owner-1';
const ANALYSIS_ID = 'analysis-1';
const WORKFLOW_ID = 'workflow-1';
const INPUT_DIGEST =
	'b9fcffe729ec029ce020dc5e1583d9573579d6576ffd8bfc036e05ca77b8f133';
const NOW = new Date('2026-08-16T20:00:00.000Z');
const PREPARED_TRANSFER_ID = '77777777-7777-4777-8777-777777777777';
const MANIFEST_TRANSFER_ID = '88888888-8888-4888-8888-888888888888';
const OUTPUT_TRANSFER_ID = '99999999-9999-4999-8999-999999999999';

const migrationDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../migrations',
);
const migrations = [
	'0019_tracking_authority.sql',
	'0020_immutable_track_view.sql',
	'0022_tracking_artifact_publication.sql',
	'0034_tracking_availability.sql',
]
	.map((name) => readFileSync(resolve(migrationDirectory, name), 'utf8'))
	.join('\n');

let sqlite: SqliteD1Fixture | undefined;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	sqlite?.close();
	sqlite = undefined;
});

class WorkflowStepFixture {
	readonly waitForEvent = vi.fn(async (_name: string, _options: unknown) => ({
		payload: {},
	}));
	readonly names: string[] = [];
	beforeStep?: (name: string) => void;
	serializeErrors = false;
	readonly configurations = new Map<
		string,
		{
			retries?: {
				limit: number;
				delay?: (input: { ctx: { attempt: number } }) => number;
			};
			timeout?: string | number;
		} | null
	>();
	private readonly outputs = new Map<string, unknown>();

	async do<T>(
		name: string,
		callbackOrConfiguration:
			| (() => Promise<T>)
			| {
					retries?: {
						limit: number;
						delay?: (input: { ctx: { attempt: number } }) => number;
					};
					timeout?: string | number;
			  },
		configuredCallback?: () => Promise<T>,
	): Promise<T> {
		this.names.push(name);
		if (this.outputs.has(name)) return this.outputs.get(name) as T;
		const configuration =
			typeof callbackOrConfiguration === 'function'
				? null
				: callbackOrConfiguration;
		this.configurations.set(name, configuration);
		const callback =
			typeof callbackOrConfiguration === 'function'
				? callbackOrConfiguration
				: configuredCallback;
		if (!callback) throw new Error('missing Workflow callback');
		const attemptLimit = (configuration?.retries?.limit ?? 5) + 1;
		let failure: unknown;
		for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
			try {
				this.beforeStep?.(name);
				const output = await callback();
				const persisted = JSON.parse(JSON.stringify(output)) as T;
				this.outputs.set(name, persisted);
				return persisted;
			} catch (error) {
				const delay = configuration?.retries?.delay;
				if (typeof delay === 'function')
					delay({ ctx: { attempt: attempt + 1 } });
				failure =
					this.serializeErrors && error instanceof Error
						? new Error(error.message)
						: error;
			}
		}
		throw failure;
	}

	async sleep(name: string, duration: number | string): Promise<void> {
		this.names.push(name);
		if (this.outputs.has(name)) return;
		this.outputs.set(name, true);
		vi.setSystemTime(
			Date.now() + (typeof duration === 'number' ? duration : 15_000),
		);
	}
}

class CoordinatorFixture {
	readonly calls: string[] = [];
	private readonly authority: TrackingAuthority;
	private readonly trace: string[];

	constructor(authority: TrackingAuthority, trace: string[] = []) {
		this.authority = authority;
		this.trace = trace;
	}

	async enqueue(_input: GpuLeaseEnqueueInput) {
		this.calls.push('coordinator-enqueue');
		return { status: 'enqueued' as const };
	}

	async acquire(input: GpuLeaseAcquireInput): Promise<GpuLeaseAcquireResult> {
		this.calls.push('coordinator-acquire');
		this.trace.push('coordinator-acquire');
		return {
			status: 'acquired' as const,
			segmentId: input.segmentId ?? SEGMENT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			expiresAt: NOW.getTime() + 90_000,
		};
	}

	async witness(_input: GpuLeaseWitnessInput) {
		this.calls.push('coordinator-witness');
		return { status: 'ok' as const, expiresAt: NOW.getTime() + 90_000 };
	}

	async renew(_input: GpuLeaseRenewInput) {
		this.calls.push('coordinator-renew');
		return { status: 'ok' as const, expiresAt: NOW.getTime() + 90_000 };
	}

	async beginCommitHold(_input: GpuLeaseHoldInput) {
		this.calls.push('coordinator-hold');
		return {
			status: 'ok' as const,
			holdId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			expiresAt: NOW.getTime() + 30_000,
		};
	}

	async releaseCommitHold(_input: GpuLeaseHoldReleaseInput) {
		this.calls.push('coordinator-release-hold');
		return { status: 'ok' as const };
	}

	async release(input: GpuLeaseReleaseInput) {
		if (input.completed) {
			const accepted = await this.authority.acceptedArtifactFor(
				OWNER_ID,
				RUN_ID,
				SEGMENT_ID,
			);
			expect(accepted).not.toBeNull();
		}
		this.calls.push('coordinator-release');
		this.trace.push('coordinator-release');
		return { status: 'ok' as const };
	}

	async requeueProviderLoss(_input: GpuLeaseBusyInput) {
		this.calls.push('coordinator-requeue-provider-loss');
		return { status: 'ok' as const };
	}
}

const prepareAuthority = async () => {
	sqlite = createSqliteD1();
	sqlite.exec(migrations);
	const authority = new TrackingAuthority(sqlite.database);
	const preparedAuthority = new PreparedTrackViewAuthority(sqlite.database);
	await authority.createRun({
		runId: RUN_ID,
		analysisId: ANALYSIS_ID,
		ownerId: OWNER_ID,
		sequence: 1,
		workflowId: WORKFLOW_ID,
		profile: inferenceProfileFixture(),
		inputDigest: INPUT_DIGEST,
		createdAt: NOW.toISOString(),
	});
	await preparedAuthority.pinRunInput({
		ownerId: OWNER_ID,
		input: trackingRunInputFixture(),
		createdAt: NOW.toISOString(),
	});
	await preparedAuthority.acceptPreparedTrackView({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		expectedRunVersion: 1,
		expectedInputDigest: INPUT_DIGEST,
		descriptor: preparedDescriptorFixture(INPUT_DIGEST),
		objects: preparedObjectsFixture(),
		deleteAfter: '2026-08-18T20:00:00.000Z',
		createdAt: NOW.toISOString(),
	});
	return { authority, database: sqlite.database };
};

const workflowEvent = (): Readonly<
	WorkflowEvent<FirstTrackingWorkflowPayload>
> => ({
	payload: {
		ownerId: OWNER_ID,
		analysisId: ANALYSIS_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		preparedMediaId: preparedDescriptorFixture(INPUT_DIGEST).preparedMediaId,
		subjectSeed: submissionFixture().trackingRequest.subjectSeed,
	},
	timestamp: NOW,
	instanceId: WORKFLOW_ID,
	workflowName: 'rc-mech-driving-analysis',
});

const status = (
	identity: ExecutionIdentity,
	state: JobStatus['state'],
	progress: number,
	transferRequest: JobStatus['transferRequest'],
	artifact: OutputArtifact | null,
): JobStatus => ({
	contractVersion: 'tracking-provider.v1',
	runId: identity.runId,
	segmentId: identity.segmentId,
	attemptId: identity.attemptId,
	leaseId: identity.leaseId,
	fencingToken: identity.fencingToken,
	specificationDigest: identity.specificationDigest,
	profileDigest: identity.profileDigest,
	state,
	resolvedProfileDigest: identity.profileDigest,
	progress,
	transferRequest,
	artifact,
	error: null,
});

const completedStatusFixture = (submission: ExecutionIdentity): JobStatus => {
	const fixture = jobStatusFixture(true).artifact;
	if (!fixture) throw new Error('missing artifact fixture');
	return status(submission, 'completed', 99, null, {
		...fixture,
		runId: submission.runId,
		segmentId: submission.segmentId,
		attemptId: submission.attemptId,
		leaseId: submission.leaseId,
		fencingToken: submission.fencingToken,
		specificationDigest: submission.specificationDigest,
		profileDigest: submission.profileDigest,
		segment: {
			...fixture.segment,
			observationSegmentId: submission.segmentId,
		},
	});
};

const artifactFixture = async (
	authority: TrackingAuthority,
	submission: TrackingJobSubmission,
): Promise<{ artifact: OutputArtifact; bytes: Uint8Array }> => {
	const context = await authority.workflowContext({
		ownerId: OWNER_ID,
		analysisId: ANALYSIS_ID,
		runId: RUN_ID,
		workflowId: WORKFLOW_ID,
		segmentId: SEGMENT_ID,
	});
	const provenance = await subjectProvenanceForProfile(
		inferenceProfileSchema.parse(inferenceProfileFixture()),
	);
	const envelope = {
		contractVersion: 'subject-observation-segment.v1' as const,
		outcome: 'accepted' as const,
		caseId: context.prepared.caseId,
		observations: [observation(provenance)],
		openGap: null,
		provenance,
	};
	const bytes = await gzip(
		new TextEncoder().encode(`${JSON.stringify(envelope)}\n`),
	);
	return {
		bytes,
		artifact: {
			contractVersion: 'tracking-artifact.v1',
			runId: submission.runId,
			segmentId: submission.segmentId,
			attemptId: submission.attemptId,
			leaseId: submission.leaseId,
			fencingToken: submission.fencingToken,
			specificationDigest: submission.specificationDigest,
			profileDigest: submission.profileDigest,
			segment: {
				observationSegmentId: submission.segmentId,
				caseId: context.prepared.caseId,
				byteCount: bytes.byteLength,
				checksumSha256: await digest(bytes),
				contentEncoding: 'gzip',
				mediaType: 'application/vnd.rc-mech.subject-observations+json',
				observationCount: 1,
				completed: true,
				gap: null,
				provenance,
				ffmpegVersion: context.prepared.ffmpegVersion,
				sourceChecksumSha256: context.prepared.sourceChecksumSha256,
				preparedChecksumSha256: context.prepared.checksumSha256,
				preparationConfigurationDigest:
					context.prepared.preparationConfigurationDigest,
				trackingInputDigest: await trackingInputDigestFor(
					context,
					submission.segmentId,
					provenance,
				),
			},
		},
	};
};

const observation = (provenance: SubjectProvenance) => ({
	timestampMs: 100,
	frameIndex: 1,
	box: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
	center: { x: 0.2, y: 0.3 },
	visibility: 'visible' as const,
	identityConfidence: 0.9,
	origin: 'detected' as const,
	provenance,
});

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> =>
	new Uint8Array(
		await new Response(
			new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
		).arrayBuffer(),
	);

const digest = async (bytes: Uint8Array): Promise<string> => {
	const value = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(value)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
};

const jsonResponse = (value: unknown): Response =>
	new Response(JSON.stringify(value), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});

const coreWorkflowFixture = (
	attempt: TrackingWorkflowContext['attempt'] = null,
) => {
	let context: TrackingWorkflowContext = {
		seedKind: 'initial',
		ownerId: OWNER_ID,
		runId: RUN_ID,
		analysisId: ANALYSIS_ID,
		workflowId: WORKFLOW_ID,
		profileDigest: PROFILE_DIGEST,
		segmentId: SEGMENT_ID,
		preparedMediaId: preparedDescriptorFixture(INPUT_DIGEST).preparedMediaId,
		specificationDigest: '4'.repeat(64),
		availabilityDeadlineAt: NOW.getTime() + 86_400_000,
		outcome: null,
		acceptedArtifactId: null,
		outputTransferRequestId: null,
		prepared: preparedDescriptorFixture(INPUT_DIGEST),
		profile: inferenceProfileFixture(),
		seed: submissionFixture().trackingRequest.subjectSeed,
		attempt,
	};
	type Activation = {
		attemptId: string;
		leaseId: string;
		fence: number;
	};
	type Transition = {
		nextState: NonNullable<TrackingWorkflowContext['attempt']>['state'];
		progress: number;
		safeFailureCode: string | null;
	};
	const authority = {
		nextSegment: vi.fn<TrackingAuthority['nextSegment']>(async () => null),
		setWaitReason: vi.fn(async () => undefined),
		expireAvailability: vi.fn(async () => undefined),
		failUnavailableOutput: vi.fn(async () => undefined),
		createFirstSegment: vi.fn(async () => context),
		workflowContext: vi.fn(async () => context),
		activateAttempt: vi.fn(async (command: Activation) => {
			context = {
				...context,
				attempt: {
					attemptId: command.attemptId,
					leaseId: command.leaseId,
					fence: command.fence,
					state: 'active',
					progress: 0,
					safeFailureCode: null,
				},
			};
			return context.attempt;
		}),
		transitionAttempt: vi.fn(async (command: Transition) => {
			if (!context.attempt) throw new Error('missing attempt');
			context = {
				...context,
				attempt: {
					...context.attempt,
					state: command.nextState,
					progress: command.progress,
					safeFailureCode: command.safeFailureCode,
				},
			};
			return context.attempt;
		}),
		retireAttempt: vi.fn(async () => {
			if (context.attempt) context = { ...context, attempt: null };
		}),
		publicState: vi.fn(
			async (): Promise<PublicTrackingState> => ({
				runId: RUN_ID,
				lifecycle: 'running' as const,
				stage: 'tracking' as const,
				progress: 99,
				waitReason: null,
				safeFailureCode: null,
			}),
		),
		publicProvenance: vi.fn(
			async (): Promise<PublicTrackingProvenance> => ({
				runId: RUN_ID,
				profileDigest: PROFILE_DIGEST,
				segments: [],
			}),
		),
	};
	const coordinator = {
		enqueue: vi.fn<
			(input: GpuLeaseEnqueueInput) => Promise<GpuLeaseEnqueueResult>
		>(async (input) => {
			gpuLeaseEnqueueInput.parse(input);
			return { status: 'enqueued' };
		}),
		acquire: vi.fn<
			(input: GpuLeaseAcquireInput) => Promise<GpuLeaseAcquireResult>
		>(async () => ({
			status: 'acquired',
			segmentId: SEGMENT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			expiresAt: NOW.getTime() + 90_000,
		})),
		witness: vi.fn<
			(input: GpuLeaseWitnessInput) => Promise<GpuLeaseMutationResult>
		>(async () => ({ status: 'ok' })),
		renew: vi.fn<
			(input: GpuLeaseRenewInput) => Promise<GpuLeaseMutationResult>
		>(async () => ({ status: 'ok' })),
		release: vi.fn<
			(input: GpuLeaseReleaseInput) => Promise<GpuLeaseMutationResult>
		>(async () => ({ status: 'ok' })),
		requeueProviderLoss: vi.fn<
			(input: GpuLeaseBusyInput) => Promise<GpuLeaseMutationResult>
		>(async () => ({ status: 'ok' })),
		beginCommitHold: vi.fn<
			(input: GpuLeaseHoldInput) => Promise<GpuLeaseMutationResult>
		>(async () => ({ status: 'ok' })),
		releaseCommitHold: vi.fn<
			(input: GpuLeaseHoldReleaseInput) => Promise<GpuLeaseMutationResult>
		>(async () => ({ status: 'ok' })),
	};
	const provider = {
		submit: vi.fn<TrackingProvider['submit']>(async () => ({
			ok: false,
			code: 'TRACKING_PROVIDER_UNAVAILABLE',
			retryable: true,
		})),
		status: vi.fn<TrackingProvider['status']>(async () => ({
			ok: false,
			code: 'TRACKING_PROVIDER_RESPONSE_INVALID',
			retryable: false,
		})),
		cancel: vi.fn<TrackingProvider['cancel']>(async () => ({
			ok: false,
			code: 'TRACKING_PROVIDER_RESPONSE_INVALID',
			retryable: false,
		})),
		deliverTransferGrant: vi.fn<TrackingProvider['deliverTransferGrant']>(
			async () => ({
				ok: false,
				code: 'TRACKING_PROVIDER_RESPONSE_INVALID',
				retryable: false,
			}),
		),
	};
	const grants = {
		issue: vi.fn(
			async (command: {
				runId: string;
				segmentId: string;
				attemptId: string;
				leaseId: string;
				fencingToken: number;
				specificationDigest: string;
				profileDigest: string;
				transferRequestId: string;
				role: 'prepared-media' | 'frame-manifest' | 'observation-artifact';
				method: 'GET' | 'PUT';
			}) => ({
				contractVersion: 'tracking-provider.v1' as const,
				...command,
				url: 'https://r2.example/object?signature=secret',
				expiresAt: 2_000_000_000,
			}),
		),
	};
	const publication = { publish: vi.fn() };
	const evidence = {
		commit: vi.fn(async () => ({
			status: 'committed' as const,
			measurement: {
				version: 'corner-evidence.v1' as const,
				passes: [],
			},
		})),
	};
	const publishAnalysisState = vi.fn(async () => undefined);
	const workflow = new FirstTrackingSegmentWorkflow(
		authority as unknown as TrackingAuthority,
		coordinator as unknown as ConstructorParameters<
			typeof FirstTrackingSegmentWorkflow
		>[1],
		provider,
		grants,
		publication,
		evidence,
		publishAnalysisState,
	);
	return {
		authority,
		coordinator,
		getContext: () => context,
		grants,
		provider,
		publication,
		evidence,
		publishAnalysisState,
		steps: new WorkflowStepFixture(),
		workflow,
	};
};

describe('DrivingAnalysisWorkflow', () => {
	test('waits durably after gap evidence, ignores uncommitted wakeups, and resumes one immutable segment', async () => {
		const value = coreWorkflowFixture();
		value.getContext().acceptedArtifactId = ATTEMPT_ID;
		value.getContext().outcome = 'tracking-gap';
		value.authority.publicState.mockResolvedValueOnce({
			runId: RUN_ID,
			lifecycle: 'awaiting-reidentification',
			stage: 'tracking',
			progress: 99,
			waitReason: null,
			safeFailureCode: null,
		});
		const nextId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
		value.authority.nextSegment
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				...value.getContext(),
				segmentId: nextId,
				outcome: 'completed',
			});
		value.steps.waitForEvent.mockImplementation(async () => {
			expect(value.evidence.commit).toHaveBeenCalled();
			expect(value.publishAnalysisState).toHaveBeenCalledWith(
				OWNER_ID,
				ANALYSIS_ID,
				expect.objectContaining({ lifecycle: 'awaiting-reidentification' }),
			);
			expect(value.provider.submit).not.toHaveBeenCalled();
			expect(value.coordinator.acquire).not.toHaveBeenCalled();
			return { payload: {} };
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).resolves.toMatchObject({ state: { lifecycle: 'running' } });
		expect(value.steps.waitForEvent).toHaveBeenCalledTimes(2);
		expect(value.evidence.commit).toHaveBeenLastCalledWith(
			expect.objectContaining({ segmentId: nextId }),
		);
		expect(value.steps.names).toContain(
			`${nextId}-commit-accepted-corner-evidence-accepted-replay`,
		);
	});

	test('a correction acquires fresh FIFO capacity and replay never resubmits it', async () => {
		const value = coreWorkflowFixture();
		value.getContext().acceptedArtifactId = ATTEMPT_ID;
		value.authority.publicState.mockResolvedValueOnce({
			runId: RUN_ID,
			lifecycle: 'awaiting-reidentification',
			stage: 'tracking',
			progress: 99,
			waitReason: null,
			safeFailureCode: null,
		});
		const nextId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
		value.steps.waitForEvent.mockImplementation(async () => {
			Object.assign(value.getContext(), {
				segmentId: nextId,
				seedKind: 'reidentification',
				acceptedArtifactId: null,
				outputTransferRequestId: OUTPUT_TRANSFER_ID,
			});
			return { payload: {} };
		});
		value.authority.nextSegment.mockImplementation(async () =>
			value.getContext(),
		);
		value.coordinator.acquire.mockResolvedValue({
			status: 'acquired',
			segmentId: nextId,
			leaseId: LEASE_ID,
			fence: 7,
			expiresAt: NOW.getTime() + 90_000,
		});
		value.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value: completedStatusFixture(submission),
		}));
		for (let replay = 0; replay < 2; replay += 1)
			await value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			);
		expect(value.coordinator.enqueue).toHaveBeenCalledOnce();
		expect(value.coordinator.enqueue).toHaveBeenCalledWith({
			segmentId: nextId,
			deadlineAt: value.getContext().availabilityDeadlineAt,
			kind: 'reidentification',
		});
		expect(value.provider.submit).toHaveBeenCalledOnce();
		expect(value.provider.submit).toHaveBeenCalledWith(
			expect.objectContaining({ segmentId: nextId }),
			value.getContext().availabilityDeadlineAt,
		);
	});

	test('consumes a correction already committed before the gap public result is read', async () => {
		const value = coreWorkflowFixture();
		value.getContext().acceptedArtifactId = ATTEMPT_ID;
		value.authority.publicProvenance.mockResolvedValueOnce({
			runId: RUN_ID,
			profileDigest: PROFILE_DIGEST,
			segments: [
				{
					segmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
					order: 0,
					outcome: 'completed',
					gap: null,
					artifact: null,
				},
				{
					segmentId: SEGMENT_ID,
					order: 1,
					outcome: 'tracking-gap',
					gap: { startTimestampMs: 250, reason: 'missing' },
					artifact: null,
				},
			],
		});
		value.authority.nextSegment.mockResolvedValue(value.getContext());
		await value.workflow.run(
			workflowEvent(),
			value.steps as unknown as WorkflowStep,
		);
		expect(value.steps.waitForEvent).toHaveBeenCalledOnce();
	});

	test('a cancelled gap wait cannot resume execution', async () => {
		const value = coreWorkflowFixture();
		value.getContext().acceptedArtifactId = ATTEMPT_ID;
		value.authority.publicState.mockResolvedValueOnce({
			runId: RUN_ID,
			lifecycle: 'awaiting-reidentification',
			stage: 'tracking',
			progress: 99,
			waitReason: null,
			safeFailureCode: null,
		});
		value.authority.nextSegment.mockRejectedValue(
			new Error('cancelled authority'),
		);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toThrow('cancelled authority');
		expect(value.provider.submit).not.toHaveBeenCalled();
		expect(value.coordinator.enqueue).not.toHaveBeenCalled();
	});

	test('replays publication after a lost acceptance acknowledgement without reauthorizing completed execution', async () => {
		const value = coreWorkflowFixture();
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value: completedStatusFixture(submission),
		}));
		value.publication.publish.mockImplementationOnce(async () => {
			value.getContext().acceptedArtifactId =
				'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
			throw new Error('lost acceptance acknowledgement');
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).resolves.toMatchObject({ state: { progress: 99 } });
		expect(value.publication.publish).toHaveBeenCalledTimes(2);
		expect(value.provider.submit).toHaveBeenCalledOnce();
		expect(value.evidence.commit).toHaveBeenCalledOnce();
	});
	test('expires before recovery without retiring or replacing computation after the deadline', async () => {
		const value = coreWorkflowFixture();
		value.provider.submit.mockResolvedValue({
			ok: false,
			code: 'GPU_CAPACITY_BUSY',
			retryable: true,
		});
		value.steps.beforeStep = (name) => {
			if (name.startsWith('retire-lost-tracking-attempt'))
				vi.setSystemTime(value.getContext().availabilityDeadlineAt);
		};
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
		expect(value.authority.retireAttempt).not.toHaveBeenCalled();
		expect(value.coordinator.acquire).toHaveBeenCalledOnce();
		expect(value.authority.expireAvailability).toHaveBeenCalledOnce();
	});

	test('retries lost deadline-write acknowledgements without reloading the now-failed run', async () => {
		const value = coreWorkflowFixture();
		value.getContext().availabilityDeadlineAt = NOW.getTime();
		value.authority.expireAvailability.mockImplementationOnce(async () => {
			value.authority.workflowContext.mockRejectedValue(
				new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'),
			);
			throw new Error('lost acknowledgement');
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
		expect(value.authority.expireAvailability).toHaveBeenCalledTimes(2);
		expect(value.coordinator.acquire).not.toHaveBeenCalled();
		expect(value.provider.submit).not.toHaveBeenCalled();
	});

	test('rejects a capacity grant for a different segment', async () => {
		const value = coreWorkflowFixture();
		value.coordinator.acquire.mockResolvedValue({
			status: 'acquired',
			segmentId: 'wrong-segment',
			leaseId: LEASE_ID,
			fence: 7,
			expiresAt: NOW.getTime() + 90_000,
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_AUTHORITY_STALE' });
		expect(value.authority.activateAttempt).not.toHaveBeenCalled();
		expect(value.provider.submit).not.toHaveBeenCalled();
	});
	test.each(['capacity', 'provider'] as const)(
		'reloads cancelled authority after a %s sleep before further contact',
		async (wait) => {
			const value = coreWorkflowFixture();
			if (wait === 'capacity')
				value.coordinator.acquire.mockResolvedValue({ status: 'busy' });
			const sleep = value.steps.sleep.bind(value.steps);
			vi.spyOn(value.steps, 'sleep').mockImplementation(
				async (name, duration) => {
					await sleep(name, duration);
					value.authority.workflowContext.mockRejectedValue(
						new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'),
					);
				},
			);
			await expect(
				value.workflow.run(
					workflowEvent(),
					value.steps as unknown as WorkflowStep,
				),
			).rejects.toMatchObject({ code: 'TRACKING_AUTHORITY_STALE' });
			expect(value.coordinator.acquire).toHaveBeenCalledOnce();
			expect(value.provider.submit).toHaveBeenCalledTimes(
				wait === 'capacity' ? 0 : 1,
			);
			expect(value.grants.issue).not.toHaveBeenCalled();
			expect(value.authority.expireAvailability).not.toHaveBeenCalled();
		},
	);

	test('does not renew expired output-ready authority after a provider retry sleep', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'output-ready',
			progress: 90,
			safeFailureCode: null,
		});
		value.provider.status.mockResolvedValue({
			ok: false,
			code: 'TRACKING_PROVIDER_UNAVAILABLE',
			retryable: true,
		});
		value.coordinator.witness.mockImplementation(async () => ({
			status: Date.now() === NOW.getTime() ? 'ok' : 'stale',
		}));
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
		expect(value.provider.status).toHaveBeenCalledOnce();
		expect(value.provider.submit).not.toHaveBeenCalled();
		expect(value.coordinator.renew).not.toHaveBeenCalled();
	});
	test.each([false, true])(
		'stays within the configured durable step budget for a full day of status polling with intermittent outages: %s',
		async (intermittent) => {
			const value = coreWorkflowFixture();
			value.provider.submit.mockImplementation(async (submission) => ({
				ok: true,
				value: status(submission, 'processing', 50, null, null),
			}));
			let contacts = 0;
			value.provider.status.mockImplementation(async (identity) => {
				contacts += 1;
				return intermittent && contacts % 2 === 1
					? {
							ok: false,
							code: 'TRACKING_PROVIDER_UNAVAILABLE',
							retryable: true,
						}
					: { ok: true, value: status(identity, 'processing', 50, null, null) };
			});
			await expect(
				value.workflow.run(
					workflowEvent(),
					value.steps as unknown as WorkflowStep,
				),
			).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
			expect(value.steps.configurations.size).toBeLessThan(25_000);
			expect(Date.now()).toBe(NOW.getTime() + 86_400_000);
		},
	);
	test('does not replace output-ready computation after a contradictory interrupted response', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'output-ready',
			progress: 90,
			safeFailureCode: null,
		});
		value.provider.status.mockResolvedValue({
			ok: false,
			code: 'JOB_INTERRUPTED',
			retryable: true,
		});
		value.provider.submit.mockResolvedValue({
			ok: false,
			code: 'TRACKING_PROVIDER_RESPONSE_INVALID',
			retryable: false,
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_FAILED' });
		expect(value.authority.retireAttempt).not.toHaveBeenCalled();
		expect(value.provider.submit).not.toHaveBeenCalled();
	});
	test('publishes safe deadline expiry when recovery wakes after the original deadline', async () => {
		const value = coreWorkflowFixture();
		value.getContext().availabilityDeadlineAt = Date.now() + 1_000;
		value.provider.submit.mockResolvedValue({
			ok: false,
			code: 'GPU_CAPACITY_BUSY',
			retryable: true,
		});
		const sleep = value.steps.sleep.bind(value.steps);
		vi.spyOn(value.steps, 'sleep').mockImplementation(
			async (name, duration) => {
				await sleep(name, duration);
				vi.setSystemTime(Date.now() + 1);
			},
		);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
		expect(value.authority.expireAvailability).toHaveBeenCalledOnce();
		expect(value.coordinator.acquire).toHaveBeenCalledOnce();
	});

	test('publishes safe expiry if the deadline crosses during enqueue', async () => {
		const value = coreWorkflowFixture();
		value.coordinator.enqueue.mockImplementation(async (input) => {
			vi.setSystemTime(input.deadlineAt + 1);
			gpuLeaseEnqueueInput.parse(input);
			return { status: 'enqueued' };
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
		expect(value.authority.expireAvailability).toHaveBeenCalledOnce();
		expect(value.coordinator.acquire).not.toHaveBeenCalled();
		expect(value.provider.submit).not.toHaveBeenCalled();
	});

	test('replaces a still-current processing attempt when an ordinary status sleep wakes after lease expiry', async () => {
		const value = coreWorkflowFixture();
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		const replacementLease = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		value.coordinator.acquire
			.mockResolvedValueOnce({
				status: 'acquired',
				segmentId: SEGMENT_ID,
				leaseId: LEASE_ID,
				fence: 7,
				expiresAt: NOW.getTime() + 90_000,
			})
			.mockResolvedValue({
				status: 'acquired',
				segmentId: SEGMENT_ID,
				leaseId: replacementLease,
				fence: 8,
				expiresAt: NOW.getTime() + 200_000,
			});
		value.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value:
				submission.leaseId === LEASE_ID
					? status(submission, 'processing', 50, null, null)
					: completedStatusFixture(submission),
		}));
		value.coordinator.witness.mockImplementation(async (identity) => ({
			status:
				identity.leaseId === LEASE_ID && Date.now() >= NOW.getTime() + 90_000
					? 'stale'
					: 'ok',
		}));
		const sleep = value.steps.sleep.bind(value.steps);
		vi.spyOn(value.steps, 'sleep').mockImplementation(
			async (name, duration) => {
				await sleep(name, duration);
				if (name.startsWith('wait-for-tracking-status'))
					vi.setSystemTime(Date.now() + 90_000);
			},
		);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).resolves.toMatchObject({ state: { progress: 99 } });
		expect(value.provider.status).not.toHaveBeenCalled();
		expect(value.authority.retireAttempt).toHaveBeenCalledOnce();
		expect(value.provider.submit).toHaveBeenCalledTimes(2);
		expect(value.authority.createFirstSegment).toHaveBeenCalledOnce();
	});

	test.each([
		'deadline',
		'lost-output',
		'lost-processing',
		'cancelled',
	] as const)(
		'rechecks %s authority during a long retry sleep',
		async (mode) => {
			const value = coreWorkflowFixture({
				attemptId: ATTEMPT_ID,
				leaseId: LEASE_ID,
				fence: 7,
				state: mode === 'lost-processing' ? 'processing' : 'output-ready',
				progress: 90,
				safeFailureCode: null,
			});
			value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
			value.provider.status.mockResolvedValue({
				ok: false,
				code: 'TRACKING_PROVIDER_UNAVAILABLE',
				retryable: true,
			});
			value.provider.submit.mockImplementation(async (identity) =>
				identity.attemptId === ATTEMPT_ID
					? {
							ok: false,
							code: 'TRACKING_PROVIDER_UNAVAILABLE',
							retryable: true,
						}
					: { ok: true, value: completedStatusFixture(identity) },
			);
			let interrupted = false;
			value.steps.beforeStep = (name) => {
				if (!name.includes('-heartbeat-') || interrupted) return;
				interrupted = true;
				if (mode === 'deadline')
					vi.setSystemTime(value.getContext().availabilityDeadlineAt);
				else if (mode === 'cancelled')
					value.authority.workflowContext.mockRejectedValue(
						new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'),
					);
				else
					value.coordinator.witness.mockResolvedValueOnce({ status: 'stale' });
			};
			const run = value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			);
			if (mode === 'lost-processing') {
				await expect(run).resolves.toMatchObject({ state: { progress: 99 } });
				expect(value.authority.retireAttempt).toHaveBeenCalledOnce();
			} else {
				await expect(run).rejects.toMatchObject({
					code:
						mode === 'deadline' || mode === 'lost-output'
							? 'TRACKING_PROVIDER_UNAVAILABLE'
							: 'TRACKING_AUTHORITY_STALE',
				});
				expect(value.authority.retireAttempt).not.toHaveBeenCalled();
				expect(value.publication.publish).not.toHaveBeenCalled();
			}
			expect(interrupted).toBe(true);
		},
	);

	test('fails unavailable output authority lost while a transient response is in flight', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'output-ready',
			progress: 90,
			safeFailureCode: null,
		});
		value.provider.status.mockImplementation(async () => {
			value.coordinator.witness.mockResolvedValue({ status: 'stale' });
			return {
				ok: false,
				code: 'TRACKING_PROVIDER_UNAVAILABLE',
				retryable: true,
			};
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
		expect(value.provider.status).toHaveBeenCalledOnce();
		expect(value.authority.retireAttempt).not.toHaveBeenCalled();
		expect(value.coordinator.renew).not.toHaveBeenCalled();
	});

	test('durably retries an enqueue transport failure before its deadline', async () => {
		const value = coreWorkflowFixture();
		value.coordinator.enqueue.mockRejectedValueOnce(
			new Error('temporary coordinator transport'),
		);
		value.provider.submit.mockResolvedValue({
			ok: false,
			code: 'INVALID_REQUEST',
			retryable: false,
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_FAILED' });
		expect(value.coordinator.enqueue).toHaveBeenCalledTimes(2);
	});

	test('rejects a completed response if its lease expires during provider contact', async () => {
		const value = coreWorkflowFixture();
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.provider.submit.mockImplementation(async (identity) => {
			value.coordinator.witness.mockResolvedValue({ status: 'stale' });
			return { ok: true, value: completedStatusFixture(identity) };
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_AUTHORITY_STALE' });
		expect(value.publication.publish).not.toHaveBeenCalled();
		expect(value.authority.retireAttempt).not.toHaveBeenCalled();
	});

	test('fails retryably without renewing or duplicating output-ready work when its lease expires during an outage', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'output-ready',
			progress: 90,
			safeFailureCode: null,
		});
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		let leaseExpiresAt = Date.now() + 90_000;
		value.coordinator.witness.mockImplementation(async () => ({
			status: Date.now() < leaseExpiresAt ? 'ok' : 'stale',
		}));
		value.coordinator.renew.mockImplementation(async () => {
			if (Date.now() >= leaseExpiresAt) return { status: 'stale' };
			leaseExpiresAt = Date.now() + 90_000;
			return { status: 'ok', expiresAt: leaseExpiresAt };
		});
		value.provider.status.mockImplementation(async (identity) =>
			Date.now() < NOW.getTime() + 600_000
				? { ok: false, code: 'TRACKING_PROVIDER_UNAVAILABLE', retryable: true }
				: { ok: true, value: completedStatusFixture(identity) },
		);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
		expect(value.provider.submit).not.toHaveBeenCalled();
		expect(value.authority.retireAttempt).not.toHaveBeenCalled();
		expect(value.coordinator.renew).not.toHaveBeenCalled();
		expect(value.publication.publish).not.toHaveBeenCalled();
		expect(value.authority.failUnavailableOutput).toHaveBeenCalledOnce();
		expect(value.authority.expireAvailability).not.toHaveBeenCalled();
		expect(value.coordinator.release).toHaveBeenCalledOnce();
	});

	test.each([
		{ phase: 'grant', loss: 'lease' },
		{ phase: 'acceptance', loss: 'lease' },
		{ phase: 'grant', loss: 'deadline' },
		{ phase: 'acceptance', loss: 'deadline' },
		{ phase: 'grant-rejection', loss: 'lease' },
		{ phase: 'grant-rejection', loss: 'deadline' },
		{ phase: 'publication-rejection', loss: 'lease' },
		{ phase: 'publication-rejection', loss: 'deadline' },
		{ phase: 'renewal', loss: 'lease' },
		{ phase: 'renewal', loss: 'deadline' },
	] as const)(
		'persists $loss authority loss during $phase without relying on exception prototypes',
		async ({ phase, loss }) => {
			const value = coreWorkflowFixture({
				attemptId: ATTEMPT_ID,
				leaseId: LEASE_ID,
				fence: 7,
				state: 'output-ready',
				progress: 90,
				safeFailureCode: null,
			});
			value.steps.serializeErrors = true;
			value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
			const loseAuthority = () => {
				if (loss === 'deadline')
					vi.setSystemTime(value.getContext().availabilityDeadlineAt);
				else value.coordinator.witness.mockResolvedValue({ status: 'stale' });
			};
			value.provider.status.mockImplementation(async (identity) => ({
				ok: true,
				value:
					phase.startsWith('grant') || phase === 'renewal'
						? {
								...completedStatusFixture(identity),
								state: 'output-ready',
								transferRequest: {
									transferRequestId: OUTPUT_TRANSFER_ID,
									role: 'observation-artifact',
									method: 'PUT',
								},
							}
						: completedStatusFixture(identity),
			}));
			if (phase === 'publication-rejection') {
				value.publication.publish.mockImplementation(async () => {
					loseAuthority();
					throw new TrackingArtifactPublicationError('STALE_AUTHORITY');
				});
			} else if (phase === 'renewal') {
				value.coordinator.renew.mockImplementation(async () => {
					loseAuthority();
					return { status: 'stale' };
				});
			} else if (phase.startsWith('grant')) {
				const issue = value.grants.issue.getMockImplementation();
				if (!issue) throw new Error('missing grant fixture');
				value.grants.issue.mockImplementation(async (command) => {
					if (phase === 'grant-rejection') {
						loseAuthority();
						throw new TrackingTransferGrantError('LEASE_MISMATCH');
					}
					const grant = await issue(command);
					loseAuthority();
					return grant;
				});
			} else
				value.steps.beforeStep = (name) => {
					if (name === 'accept-first-tracking-evidence') loseAuthority();
				};
			for (let replay = 0; replay < 2; replay += 1)
				await expect(
					value.workflow.run(
						workflowEvent(),
						value.steps as unknown as WorkflowStep,
					),
				).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
			expect(value.authority.failUnavailableOutput).toHaveBeenCalledTimes(
				loss === 'lease' ? 1 : 0,
			);
			expect(value.authority.expireAvailability).toHaveBeenCalledTimes(
				loss === 'deadline' ? 1 : 0,
			);
			expect(value.publication.publish).toHaveBeenCalledTimes(
				phase === 'publication-rejection' ? 1 : 0,
			);
			expect(value.provider.deliverTransferGrant).not.toHaveBeenCalled();
			expect(value.provider.submit).not.toHaveBeenCalled();
		},
	);

	test('retries an authority read outage before accepting output', async () => {
		const value = coreWorkflowFixture();
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.provider.submit.mockImplementation(async (identity) => ({
			ok: true,
			value: completedStatusFixture(identity),
		}));
		let interrupted = false;
		value.steps.beforeStep = (name) => {
			if (name !== 'accept-first-tracking-evidence' || interrupted) return;
			interrupted = true;
			value.authority.workflowContext
				.mockResolvedValueOnce(value.getContext())
				.mockRejectedValueOnce(new Error('transient D1 outage'));
		};
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).resolves.toMatchObject({ state: { progress: 99 } });
		expect(value.publication.publish).toHaveBeenCalledOnce();
	});

	test('replays output authority failure and lost release acknowledgements without reloading the failed run', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'output-ready',
			progress: 90,
			safeFailureCode: null,
		});
		value.coordinator.witness.mockResolvedValue({ status: 'stale' });
		value.authority.failUnavailableOutput.mockImplementation(async () => {
			value.authority.workflowContext.mockRejectedValue(
				new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'),
			);
		});
		value.coordinator.release.mockRejectedValueOnce(
			new Error('lost release acknowledgement'),
		);
		for (let replay = 0; replay < 2; replay += 1)
			await expect(
				value.workflow.run(
					workflowEvent(),
					value.steps as unknown as WorkflowStep,
				),
			).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
		expect(value.authority.failUnavailableOutput).toHaveBeenCalledOnce();
		expect(value.coordinator.release).toHaveBeenCalledTimes(2);
		expect(value.authority.expireAvailability).not.toHaveBeenCalled();
		expect(value.provider.submit).not.toHaveBeenCalled();
	});

	test('recovers output-ready status and transfer outages without resubmission or duplicate commits on replay', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'output-ready',
			progress: 90,
			safeFailureCode: null,
		});
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.provider.status
			.mockResolvedValueOnce({
				ok: false,
				code: 'TRACKING_PROVIDER_UNAVAILABLE',
				retryable: true,
			})
			.mockImplementation(async (identity) => ({
				ok: true,
				value: {
					...completedStatusFixture(identity as TrackingJobSubmission),
					state: 'output-ready',
					transferRequest: {
						transferRequestId: OUTPUT_TRANSFER_ID,
						role: 'observation-artifact',
						method: 'PUT',
					},
				},
			}));
		value.provider.deliverTransferGrant
			.mockResolvedValueOnce({
				ok: false,
				code: 'TRACKING_PROVIDER_UNAVAILABLE',
				retryable: true,
			})
			.mockImplementation(async (grant) => ({
				ok: true,
				value: completedStatusFixture(grant),
			}));
		for (let replay = 0; replay < 2; replay += 1) {
			await expect(
				value.workflow.run(
					workflowEvent(),
					value.steps as unknown as WorkflowStep,
				),
			).resolves.toMatchObject({ state: { progress: 99 } });
		}
		expect(value.provider.submit).not.toHaveBeenCalled();
		expect(value.provider.deliverTransferGrant).toHaveBeenCalledTimes(2);
		expect(value.provider.status).toHaveBeenCalledTimes(2);
		expect(value.evidence.commit).toHaveBeenCalledOnce();
		expect(value.publication.publish).toHaveBeenCalledOnce();
	});
	test('never resubmits finalized computation when its resumed lease has expired', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'output-ready',
			progress: 90,
			safeFailureCode: null,
		});
		value.coordinator.witness.mockResolvedValue({ status: 'stale' });
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
		expect(value.coordinator.acquire).not.toHaveBeenCalled();
		expect(value.provider.submit).not.toHaveBeenCalled();
		expect(value.publication.publish).not.toHaveBeenCalled();
	});
	test('reacquires with a new attempt when a transport retry outlives its lease', async () => {
		const value = coreWorkflowFixture();
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.coordinator.acquire.mockResolvedValueOnce({
			status: 'acquired',
			segmentId: SEGMENT_ID,
			leaseId: LEASE_ID,
			fence: 6,
			expiresAt: NOW.getTime() + 1_000,
		});
		value.provider.submit
			.mockResolvedValueOnce({
				ok: false,
				code: 'TRACKING_PROVIDER_UNAVAILABLE',
				retryable: true,
			})
			.mockImplementation(async (submission) => ({
				ok: true,
				value: completedStatusFixture(submission),
			}));
		value.coordinator.witness.mockImplementation(async (input) => ({
			status: input.fence === 6 && Date.now() > NOW.getTime() ? 'stale' : 'ok',
		}));
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).resolves.toMatchObject({ state: { progress: 99 } });
		expect(value.authority.retireAttempt).toHaveBeenCalledOnce();
		expect(value.provider.submit).toHaveBeenCalledTimes(2);
		expect(value.provider.submit.mock.calls[0]?.[0].attemptId).not.toBe(
			value.provider.submit.mock.calls[1]?.[0].attemptId,
		);
	});

	test('replaces processing work when renewal discovers an expired lease', async () => {
		const value = coreWorkflowFixture();
		value.steps.serializeErrors = true;
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.coordinator.acquire.mockResolvedValueOnce({
			status: 'acquired',
			segmentId: SEGMENT_ID,
			leaseId: LEASE_ID,
			fence: 6,
			expiresAt: NOW.getTime() + 90_000,
		});
		value.provider.submit
			.mockImplementationOnce(async (submission) => ({
				ok: true,
				value: status(submission, 'processing', 40, null, null),
			}))
			.mockImplementation(async (submission) => ({
				ok: true,
				value: completedStatusFixture(submission),
			}));
		value.coordinator.renew.mockImplementationOnce(async () => {
			value.coordinator.witness.mockImplementation(async (input) => ({
				status: input.fence === 6 ? 'stale' : 'ok',
			}));
			return { status: 'stale' };
		});
		for (let replay = 0; replay < 2; replay += 1)
			await expect(
				value.workflow.run(
					workflowEvent(),
					value.steps as unknown as WorkflowStep,
				),
			).resolves.toMatchObject({ state: { progress: 99 } });
		expect(value.authority.createFirstSegment).toHaveBeenCalledOnce();
		expect(value.authority.retireAttempt).toHaveBeenCalledOnce();
		expect(value.provider.submit).toHaveBeenCalledTimes(2);
		expect(value.provider.submit.mock.calls[0]?.[0].attemptId).not.toBe(
			value.provider.submit.mock.calls[1]?.[0].attemptId,
		);
	});

	test('rejects a completed response arriving at the deadline before publication', async () => {
		const value = coreWorkflowFixture();
		value.getContext().availabilityDeadlineAt = NOW.getTime() + 1_000;
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.provider.submit.mockImplementation(async (submission) => {
			vi.setSystemTime(NOW.getTime() + 1_000);
			return { ok: true, value: completedStatusFixture(submission) };
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
		expect(value.publication.publish).not.toHaveBeenCalled();
	});

	test('restarts confirmed interrupted computation under one immutable segment', async () => {
		const value = coreWorkflowFixture();
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.coordinator.acquire.mockResolvedValueOnce({
			status: 'acquired',
			segmentId: SEGMENT_ID,
			leaseId: LEASE_ID,
			fence: 6,
			expiresAt: NOW.getTime() + 90_000,
		});
		value.provider.submit
			.mockImplementationOnce(async (submission) => ({
				ok: true,
				value: status(submission, 'interrupted', 40, null, null),
			}))
			.mockImplementation(async (submission) => ({
				ok: true,
				value: completedStatusFixture(submission),
			}));
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).resolves.toMatchObject({ state: { progress: 99 } });
		expect(value.authority.createFirstSegment).toHaveBeenCalledOnce();
		expect(value.authority.retireAttempt).toHaveBeenCalledOnce();
		expect(value.provider.submit.mock.calls[0]?.[0].attemptId).not.toBe(
			value.provider.submit.mock.calls[1]?.[0].attemptId,
		);
	});

	test('restores the original FIFO waiter before sleeping after GPU capacity busy', async () => {
		const value = coreWorkflowFixture();
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.coordinator.acquire.mockResolvedValueOnce({
			status: 'acquired',
			segmentId: SEGMENT_ID,
			leaseId: LEASE_ID,
			fence: 6,
			expiresAt: NOW.getTime() + 90_000,
		});
		value.provider.submit
			.mockResolvedValueOnce({
				ok: false,
				code: 'GPU_CAPACITY_BUSY',
				retryable: true,
			})
			.mockImplementation(async (submission) => ({
				ok: true,
				value: completedStatusFixture(submission),
			}));
		const sleep = value.steps.sleep.bind(value.steps);
		vi.spyOn(value.steps, 'sleep').mockImplementation(
			async (name, duration) => {
				expect(value.coordinator.requeueProviderLoss).toHaveBeenCalledOnce();
				expect(value.authority.retireAttempt).toHaveBeenCalledOnce();
				return sleep(name, duration);
			},
		);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).resolves.toMatchObject({ state: { progress: 99 } });
	});

	test('persists and clears the provider wait around transient retries', async () => {
		const value = coreWorkflowFixture();
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.provider.submit
			.mockResolvedValueOnce({
				ok: false,
				code: 'TRACKING_PROVIDER_UNAVAILABLE',
				retryable: true,
			})
			.mockImplementation(async (submission) => ({
				ok: true,
				value: completedStatusFixture(submission),
			}));
		await value.workflow.run(
			workflowEvent(),
			value.steps as unknown as WorkflowStep,
		);
		expect(value.authority.setWaitReason.mock.calls).toEqual(
			expect.arrayContaining([
				[expect.objectContaining({ waitReason: 'waiting-for-provider' })],
				[expect.objectContaining({ waitReason: null })],
			]),
		);
	});

	test('publishes capacity waits and records expiry before any attempt is acquired', async () => {
		const value = coreWorkflowFixture();
		value.getContext().availabilityDeadlineAt = NOW.getTime() + 2_000;
		value.coordinator.acquire.mockResolvedValue({ status: 'busy' });
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
		expect(value.authority.setWaitReason).toHaveBeenCalledWith(
			expect.objectContaining({
				waitReason: 'waiting-for-capacity',
				expectedCurrentAttemptId: null,
			}),
		);
		expect(value.authority.expireAvailability).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedCurrentAttemptId: null,
				expiredAt: NOW.getTime() + 2_000,
			}),
		);
		expect(value.provider.submit).not.toHaveBeenCalled();
		expect(value.coordinator.acquire).toHaveBeenCalledOnce();
		expect(Date.now()).toBe(NOW.getTime() + 2_000);
	});

	test('waits durably for capacity and resumes the same queued segment', async () => {
		const value = coreWorkflowFixture();
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.coordinator.acquire.mockResolvedValueOnce({ status: 'busy' });
		value.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value: completedStatusFixture(submission),
		}));
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).resolves.toMatchObject({ state: { progress: 99 } });
		expect(value.coordinator.enqueue).toHaveBeenCalledOnce();
		expect(value.coordinator.acquire).toHaveBeenCalledTimes(2);
		expect(Date.now()).toBe(NOW.getTime() + 15_000);
	});

	test('retries a temporary submission outage under the original attempt', async () => {
		const value = coreWorkflowFixture();
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.provider.submit
			.mockResolvedValueOnce({
				ok: false,
				code: 'TRACKING_PROVIDER_UNAVAILABLE',
				retryable: true,
			})
			.mockImplementation(async (submission) => ({
				ok: true,
				value: completedStatusFixture(submission),
			}));
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).resolves.toMatchObject({ state: { progress: 99 } });
		expect(value.authority.retireAttempt).not.toHaveBeenCalled();
		expect(value.coordinator.acquire).toHaveBeenCalledOnce();
		expect(Date.now()).toBeGreaterThan(NOW.getTime());
		expect(value.provider.submit.mock.calls[0]?.[0].attemptId).toBe(
			value.provider.submit.mock.calls[1]?.[0].attemptId,
		);
	});

	test('replays a serialized permanent provider rejection as the same safe failure', async () => {
		const value = coreWorkflowFixture();
		value.provider.submit.mockResolvedValue({
			ok: false,
			code: 'AUTHORITY_MISMATCH',
			retryable: false,
		});
		for (let replay = 0; replay < 2; replay += 1) {
			await expect(
				value.workflow.run(
					workflowEvent(),
					value.steps as unknown as WorkflowStep,
				),
			).rejects.toEqual(new TrackingWorkflowError('TRACKING_PROVIDER_FAILED'));
		}
		expect(value.provider.submit).toHaveBeenCalledOnce();
	});

	test('starts the fixed deadline when prepared tracking becomes executable', async () => {
		const value = coreWorkflowFixture();
		vi.setSystemTime(new Date('2026-08-17T02:00:00.000Z'));
		await value.workflow
			.run(workflowEvent(), value.steps as unknown as WorkflowStep)
			.catch(() => undefined);
		expect(value.authority.createFirstSegment).toHaveBeenCalledWith(
			expect.objectContaining({
				availabilityDeadlineAt: Date.parse('2026-08-18T02:00:00.000Z'),
			}),
		);
	});

	test('runs the first immutable segment through LocalSam31Provider and commits evidence before release', async () => {
		const commitEvidence = vi
			.spyOn(AcceptedCornerEvidence.prototype, 'commit')
			.mockResolvedValue({
				status: 'committed',
				measurement: { version: 'corner-evidence.v1', passes: [] },
			});
		const publishTrackingState = vi
			.spyOn(DrivingAnalysisAuthority.prototype, 'publishTrackingState')
			.mockResolvedValue({ kind: 'stale' });
		const { authority, database } = await prepareAuthority();
		const r2 = new MockR2Controller();
		const trace: string[] = [];
		const coordinator = new CoordinatorFixture(authority, trace);
		const providerCalls: string[] = [];
		let submission: TrackingJobSubmission | undefined;
		let artifact: OutputArtifact | undefined;
		let bytes: Uint8Array | undefined;
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			const path = new URL(request.url).pathname;
			if (path === '/v1/jobs') {
				submission = (await request.json()) as TrackingJobSubmission;
				const current = await authority.workflowContext({
					ownerId: OWNER_ID,
					analysisId: ANALYSIS_ID,
					runId: RUN_ID,
					workflowId: WORKFLOW_ID,
					segmentId: SEGMENT_ID,
				});
				expect(current.attempt?.state).toBe('active');
				expect(current.attempt?.leaseId).toBe(LEASE_ID);
				({ artifact, bytes } = await artifactFixture(authority, submission));
				providerCalls.push('provider-submit');
				trace.push('provider-submit');
				return jsonResponse(
					status(
						submission,
						'transfer-grant-required',
						0,
						{
							transferRequestId: PREPARED_TRANSFER_ID,
							role: 'prepared-media',
							method: 'GET',
						},
						null,
					),
				);
			}
			if (path.endsWith('/transfer-grants')) {
				const grant = (await request.json()) as TransferGrantCommand;
				providerCalls.push(`provider-grant-${grant.role}`);
				if (!submission || !artifact || !bytes)
					throw new Error('submission fixture was not prepared');
				if (grant.role === 'prepared-media')
					return jsonResponse(
						status(
							submission,
							'transfer-grant-required',
							10,
							{
								transferRequestId: MANIFEST_TRANSFER_ID,
								role: 'frame-manifest',
								method: 'GET',
							},
							null,
						),
					);
				if (grant.role === 'frame-manifest')
					return jsonResponse(status(submission, 'processing', 20, null, null));
				r2.seed(
					stagingArtifactObjectKey(submission.attemptId, OUTPUT_TRANSFER_ID),
					bytes,
					{ contentType: 'application/octet-stream' },
				);
				return jsonResponse(
					status(submission, 'completed', 99, null, artifact),
				);
			}
			if (request.method === 'GET' && path.includes('/v1/jobs/')) {
				providerCalls.push('provider-status');
				if (!submission || !artifact)
					throw new Error('submission fixture was not prepared');
				return jsonResponse(
					status(
						submission,
						'output-ready',
						90,
						{
							transferRequestId: OUTPUT_TRANSFER_ID,
							role: 'observation-artifact',
							method: 'PUT',
						},
						artifact,
					),
				);
			}
			throw new Error(`unexpected provider request: ${request.method} ${path}`);
		});
		vi.stubGlobal('fetch', fetcher);
		const environment: DrivingAnalysisWorkflowEnvironment = {
			DB: database,
			ANALYSIS_MEDIA: r2.bucket,
			GPU_LEASE_COORDINATOR: { getByName: () => coordinator },
			GPU_PROVIDER_ORIGIN: 'https://gpu.chassisnotes.com',
			GPU_ACCESS_CLIENT_ID: 'access-client-id',
			GPU_ACCESS_CLIENT_SECRET: 'access-client-secret',
			R2_ACCOUNT_ID: 'a'.repeat(32),
			R2_ACCESS_KEY_ID: 'access-key',
			R2_SECRET_ACCESS_KEY: 'secret-key',
		};
		const workflow = firstTrackingSegmentWorkflow(environment);
		const steps = new WorkflowStepFixture();
		const result = await workflow.run(
			workflowEvent(),
			steps as unknown as WorkflowStep,
		);

		expect(result).toMatchObject({
			state: {
				runId: RUN_ID,
				lifecycle: 'running',
				stage: 'tracking',
				progress: 99,
				safeFailureCode: null,
			},
			provenance: {
				runId: RUN_ID,
				profileDigest: PROFILE_DIGEST,
				segments: [
					{
						segmentId: SEGMENT_ID,
						outcome: 'completed',
						artifact: { artifactId: submission?.attemptId },
					},
				],
			},
		});
		expect(trace.indexOf('coordinator-acquire')).toBeLessThan(
			trace.indexOf('provider-submit'),
		);
		expect(providerCalls).toEqual([
			'provider-submit',
			'provider-grant-prepared-media',
			'provider-grant-frame-manifest',
			'provider-status',
			'provider-grant-observation-artifact',
		]);
		expect(coordinator.calls.at(-1)).toBe('coordinator-release');
		expect(commitEvidence).toHaveBeenCalledWith({
			ownerId: OWNER_ID,
			analysisId: ANALYSIS_ID,
			runId: RUN_ID,
			workflowId: WORKFLOW_ID,
			segmentId: SEGMENT_ID,
		});
		expect(publishTrackingState).toHaveBeenCalledWith(
			OWNER_ID,
			ANALYSIS_ID,
			expect.objectContaining({ lifecycle: 'running', progress: 99 }),
			expect.any(String),
		);
		expect(JSON.stringify(result)).not.toMatch(
			/leaseId|fencingToken|transferRequest|objectKey|gpu\.chassisnotes/i,
		);

		const callsBeforeReplay = fetcher.mock.calls.length;
		const replay = await workflow.run(
			workflowEvent(),
			steps as unknown as WorkflowStep,
		);
		expect(replay).toEqual(result);
		const authoritativeReplay = await workflow.run(
			workflowEvent(),
			new WorkflowStepFixture() as unknown as WorkflowStep,
		);
		expect(authoritativeReplay).toEqual(result);
		expect(fetcher).toHaveBeenCalledTimes(callsBeforeReplay);
		expect(
			[...steps.configurations.entries()].find(([name]) =>
				name.startsWith('submit-tracking-segment'),
			)?.[1],
		).toMatchObject({ retries: { limit: 0 }, timeout: 30000 });
	});

	test('derives stable version-four attempt identities', async () => {
		const first = await deterministicUuidV4('one immutable lease');
		expect(first).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(await deterministicUuidV4('one immutable lease')).toBe(first);
		expect(await deterministicUuidV4('another lease')).not.toBe(first);
	});

	test('retires provider-loss attempts and submits the replacement with a new identity', async () => {
		const value = coreWorkflowFixture();
		value.getContext().availabilityDeadlineAt = Date.now() + 86_400_000;
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.coordinator.acquire.mockResolvedValueOnce({
			status: 'acquired',
			segmentId: SEGMENT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			expiresAt: NOW.getTime() + 90_000,
		});
		value.coordinator.acquire.mockResolvedValueOnce({
			status: 'acquired',
			segmentId: SEGMENT_ID,
			leaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			fence: 8,
			expiresAt: NOW.getTime() + 90_000,
		});
		value.provider.submit
			.mockResolvedValueOnce({
				ok: false,
				code: 'GPU_CAPACITY_BUSY',
				retryable: true,
			})
			.mockImplementation(async (submission) => ({
				ok: true,
				value: completedStatusFixture(submission),
			}));

		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).resolves.toMatchObject({ state: { progress: 99 } });
		expect(value.provider.submit).toHaveBeenCalledTimes(2);
		expect(value.provider.submit.mock.calls[0]?.[0].attemptId).not.toBe(
			value.provider.submit.mock.calls[1]?.[0].attemptId,
		);
		expect(value.authority.retireAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ nextState: 'replaced' }),
		);
		expect(value.coordinator.requeueProviderLoss).toHaveBeenCalledOnce();
		expect(
			value.steps.names.some((name) =>
				name.startsWith('retire-lost-tracking-attempt-'),
			),
		).toBe(true);
	});

	test('keeps the attempt when polling temporarily loses the provider', async () => {
		const value = coreWorkflowFixture();
		value.getContext().availabilityDeadlineAt = Date.now() + 86_400_000;
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.coordinator.acquire.mockResolvedValueOnce({
			status: 'acquired',
			segmentId: SEGMENT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			expiresAt: NOW.getTime() + 90_000,
		});
		value.coordinator.acquire.mockResolvedValueOnce({
			status: 'acquired',
			segmentId: SEGMENT_ID,
			leaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			fence: 8,
			expiresAt: NOW.getTime() + 90_000,
		});
		value.provider.submit
			.mockResolvedValueOnce({
				ok: true,
				value: status(
					{
						...submissionFixture(),
						runId: RUN_ID,
						segmentId: SEGMENT_ID,
						attemptId: 'placeholder',
						leaseId: LEASE_ID,
						fencingToken: 7,
						specificationDigest: '4'.repeat(64),
						profileDigest: PROFILE_DIGEST,
					},
					'processing',
					20,
					null,
					null,
				),
			})
			.mockImplementation(async (submission) => ({
				ok: true,
				value: completedStatusFixture(submission),
			}));
		value.provider.status
			.mockResolvedValueOnce({
				ok: false,
				code: 'TRACKING_PROVIDER_UNAVAILABLE',
				retryable: true,
			})
			.mockImplementation(async (identity) => ({
				ok: true,
				value: completedStatusFixture(identity as TrackingJobSubmission),
			}));

		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).resolves.toMatchObject({ state: { progress: 99 } });
		expect(value.provider.status).toHaveBeenCalledTimes(2);
		expect(value.authority.retireAttempt).not.toHaveBeenCalled();
	});

	test('fails safely when provider-loss requeue is fenced by a newer lease', async () => {
		const value = coreWorkflowFixture();
		value.provider.submit.mockResolvedValue({
			ok: false,
			code: 'GPU_CAPACITY_BUSY',
			retryable: true,
		});
		value.getContext().availabilityDeadlineAt = Date.now() + 86_400_000;
		value.coordinator.requeueProviderLoss.mockResolvedValue({
			status: 'stale',
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'));
		expect(value.provider.submit).toHaveBeenCalledOnce();
	});

	test('normalizes thrown provider submission and status failures', async () => {
		const submissionFailure = coreWorkflowFixture();
		submissionFailure.provider.submit.mockRejectedValue(
			new Error('private provider detail'),
		);
		await expect(
			submissionFailure.workflow.run(
				workflowEvent(),
				submissionFailure.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_PROVIDER_FAILED'));

		const statusFailure = coreWorkflowFixture();
		statusFailure.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value: status(submission, 'processing', 20, null, null),
		}));
		statusFailure.provider.status.mockRejectedValue(
			new Error('private status detail'),
		);
		await expect(
			statusFailure.workflow.run(
				workflowEvent(),
				statusFailure.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_PROVIDER_FAILED'));

		const authorityFailure = coreWorkflowFixture();
		authorityFailure.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value: status(submission, 'processing', 20, null, null),
		}));
		authorityFailure.authority.workflowContext
			.mockResolvedValueOnce(authorityFailure.getContext())
			.mockResolvedValueOnce(authorityFailure.getContext())
			.mockResolvedValueOnce(authorityFailure.getContext())
			.mockResolvedValueOnce(authorityFailure.getContext())
			.mockRejectedValueOnce(
				new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'),
			);
		await expect(
			authorityFailure.workflow.run(
				workflowEvent(),
				authorityFailure.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'));

		const directStatusAuthorityFailure = coreWorkflowFixture();
		directStatusAuthorityFailure.provider.submit.mockImplementation(
			async (submission) => ({
				ok: true,
				value: status(submission, 'processing', 20, null, null),
			}),
		);
		directStatusAuthorityFailure.provider.status.mockRejectedValue(
			new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'),
		);
		await expect(
			directStatusAuthorityFailure.workflow.run(
				workflowEvent(),
				directStatusAuthorityFailure.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'));
	});

	test('fails polling provider loss without a requeue capability', async () => {
		const value = coreWorkflowFixture();
		delete (value.coordinator as { requeueProviderLoss?: unknown })
			.requeueProviderLoss;
		value.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value: status(submission, 'processing', 20, null, null),
		}));
		value.provider.status.mockResolvedValue({
			ok: false,
			code: 'TRACKING_PROVIDER_UNAVAILABLE',
			retryable: true,
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(
			new TrackingWorkflowError('TRACKING_PROVIDER_UNAVAILABLE'),
		);
	});

	test('deterministic jitter is bounded, repeatable, and deadline-safe', () => {
		const first = deterministicJitter('segment', 1, 5_000);
		expect(first).toBe(deterministicJitter('segment', 1, 5_000));
		expect(first).toBeGreaterThanOrEqual(0);
		expect(first).toBeLessThanOrEqual(5_000);
		expect(deterministicJitter('segment', 1, 0)).toBe(0);
		expect(deterministicJitter('segment', 1, -1)).toBe(0);
	});

	test('loads the pinned deployment profile and addresses media by run', async () => {
		expect(
			deployedInferenceProfile(JSON.stringify(inferenceProfileFixture())),
		).toEqual(inferenceProfileFixture());
		expect(() => deployedInferenceProfile(undefined)).toThrow(
			'INFERENCE_PROFILE_JSON is required for tracking',
		);
		expect(() => deployedInferenceProfile('{')).toThrow(
			'INFERENCE_PROFILE_JSON is invalid',
		);
		const prepareTrackView = vi.fn(async () => ({ outcome: 'accepted' }));
		const getByName = vi.fn(() => ({ prepareTrackView }));
		const port = raceVideoTrackViewPreparationPort({ getByName });
		const command = {
			request: { caseId: RUN_ID },
		} as Parameters<typeof port.prepare>[0];
		await expect(port.prepare(command)).resolves.toEqual({
			outcome: 'accepted',
		});
		expect(getByName).toHaveBeenCalledWith(RUN_ID);
		expect(prepareTrackView).toHaveBeenCalledWith(command);
		expect(() =>
			raceVideoTrackViewPreparationPort(undefined).prepare(command),
		).toThrow('Race-video media container is unavailable');
	});

	test('fails malformed Workflow time before touching authority', async () => {
		const value = coreWorkflowFixture();
		await expect(
			value.workflow.run(
				{ ...workflowEvent(), timestamp: new Date(Number.NaN) },
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'));
		expect(value.authority.createFirstSegment).not.toHaveBeenCalled();
	});

	test('resumes current authority and records a safe unavailable failure', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'active',
			progress: 0,
			safeFailureCode: null,
		});
		delete (value.coordinator as { requeueProviderLoss?: unknown })
			.requeueProviderLoss;
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(
			new TrackingWorkflowError('TRACKING_PROVIDER_UNAVAILABLE'),
		);
		expect(value.coordinator.acquire).not.toHaveBeenCalled();
		expect(value.authority.expireAvailability).toHaveBeenCalledWith(
			expect.objectContaining({ expectedCurrentAttemptId: ATTEMPT_ID }),
		);
		expect(value.coordinator.release).toHaveBeenCalledOnce();
	});

	test('replaces a stale resumed lease with a newly activated attempt', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			fence: 6,
			state: 'active',
			progress: 0,
			safeFailureCode: null,
		});
		value.coordinator.witness.mockResolvedValueOnce({ status: 'stale' });
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toMatchObject({ code: 'TRACKING_PROVIDER_UNAVAILABLE' });
		expect(value.coordinator.acquire).toHaveBeenCalledOnce();
		expect(value.authority.retireAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ attemptId: ATTEMPT_ID, nextState: 'expired' }),
		);
		expect(value.authority.activateAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ expectedCurrentAttemptId: null }),
		);
	});

	test('fails closed when capacity cannot return the requested segment', async () => {
		const value = coreWorkflowFixture();
		value.coordinator.acquire.mockResolvedValue({ status: 'busy' });
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(
			new TrackingWorkflowError('TRACKING_PROVIDER_UNAVAILABLE'),
		);
		expect(value.authority.activateAttempt).not.toHaveBeenCalled();
	});

	test('publishes a retryable D1 failure when capacity remains unavailable until deadline', async () => {
		vi.spyOn(
			DrivingAnalysisAuthority.prototype,
			'publishTrackingState',
		).mockResolvedValue({ kind: 'stale' });
		const { authority, database } = await prepareAuthority();
		const coordinator = new CoordinatorFixture(authority);
		vi.spyOn(coordinator, 'acquire').mockImplementation(async () => {
			vi.setSystemTime(NOW.getTime() + 86_400_000);
			return { status: 'busy' };
		});
		const environment: DrivingAnalysisWorkflowEnvironment = {
			DB: database,
			ANALYSIS_MEDIA: new MockR2Controller().bucket,
			GPU_LEASE_COORDINATOR: { getByName: () => coordinator },
			GPU_PROVIDER_ORIGIN: 'https://gpu.chassisnotes.com',
			GPU_ACCESS_CLIENT_ID: 'access-client-id',
			GPU_ACCESS_CLIENT_SECRET: 'access-client-secret',
			R2_ACCOUNT_ID: 'a'.repeat(32),
			R2_ACCESS_KEY_ID: 'access-key',
			R2_SECRET_ACCESS_KEY: 'secret-key',
		};
		const workflow = firstTrackingSegmentWorkflow(environment);
		await expect(
			workflow.run(
				workflowEvent(),
				new WorkflowStepFixture() as unknown as WorkflowStep,
			),
		).rejects.toEqual(
			new TrackingWorkflowError('TRACKING_PROVIDER_UNAVAILABLE'),
		);
		expect(await authority.publicState(OWNER_ID, ANALYSIS_ID, RUN_ID)).toEqual({
			runId: RUN_ID,
			lifecycle: 'failed',
			stage: 'tracking',
			progress: 0,
			waitReason: null,
			safeFailureCode: 'TRACKING_PROVIDER_UNAVAILABLE',
		});
	});

	test('retries an idempotent D1 activation without retrying provider contact', async () => {
		const value = coreWorkflowFixture();
		value.provider.submit.mockResolvedValue({
			ok: false,
			code: 'TRACKING_PROVIDER_RESPONSE_INVALID',
			retryable: false,
		});
		value.authority.activateAttempt.mockRejectedValueOnce(
			new Error('transient D1 failure'),
		);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_PROVIDER_FAILED'));
		expect(value.authority.activateAttempt).toHaveBeenCalledTimes(2);
		expect(value.provider.submit).toHaveBeenCalledOnce();
	});

	test('releases a lease that D1 refuses to activate', async () => {
		const value = coreWorkflowFixture();
		value.authority.activateAttempt.mockRejectedValue(
			new Error('private D1 detail'),
		);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'));
		expect(value.coordinator.release).toHaveBeenCalledOnce();
		expect(value.provider.submit).not.toHaveBeenCalled();
	});

	test('never contacts the provider when an expired lease cannot be requeued', async () => {
		const value = coreWorkflowFixture();
		value.coordinator.witness.mockResolvedValue({ status: 'stale' });
		value.coordinator.requeueProviderLoss.mockResolvedValue({
			status: 'stale',
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'));
		expect(value.provider.submit).not.toHaveBeenCalled();
		expect(value.authority.transitionAttempt).not.toHaveBeenCalledWith(
			expect.objectContaining({ nextState: 'failed' }),
		);
		expect(value.coordinator.release).not.toHaveBeenCalled();
	});

	test('records a safe failure when grant delivery is rejected', async () => {
		const value = coreWorkflowFixture();
		value.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value: status(
				submission,
				'transfer-grant-required',
				0,
				{
					transferRequestId: PREPARED_TRANSFER_ID,
					role: 'prepared-media',
					method: 'GET',
				},
				null,
			),
		}));
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_PROVIDER_FAILED'));
		expect(value.coordinator.renew).toHaveBeenCalledOnce();
		expect(value.coordinator.release).toHaveBeenCalledOnce();
	});

	test.each(['processing', 'transferring', 'cancel-requested'] as const)(
		'fails safely when the provider status read after %s is rejected',
		async (providerState) => {
			const value = coreWorkflowFixture();
			value.provider.submit.mockImplementation(async (submission) => ({
				ok: true,
				value: status(submission, providerState, 20, null, null),
			}));
			await expect(
				value.workflow.run(
					workflowEvent(),
					value.steps as unknown as WorkflowStep,
				),
			).rejects.toEqual(new TrackingWorkflowError('TRACKING_PROVIDER_FAILED'));
			expect(value.provider.status).toHaveBeenCalledOnce();
			expect(value.coordinator.release).toHaveBeenCalledOnce();
		},
	);

	test('fails closed when lease renewal loses its fence', async () => {
		const value = coreWorkflowFixture();
		value.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value: status(submission, 'processing', 20, null, null),
		}));
		value.coordinator.renew.mockResolvedValue({ status: 'stale' });
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'));
		expect(value.authority.transitionAttempt).not.toHaveBeenCalledWith(
			expect.objectContaining({ nextState: 'failed' }),
		);
		expect(value.coordinator.release).not.toHaveBeenCalled();
	});

	test.each([
		{
			name: 'terminal provider status',
			makeStatus: (submission: TrackingJobSubmission) =>
				status(submission, 'failed', 30, null, null),
			expected: 'TRACKING_PROVIDER_FAILED',
		},
		{
			name: 'output without an artifact',
			makeStatus: (submission: TrackingJobSubmission) =>
				status(
					submission,
					'output-ready',
					90,
					{
						transferRequestId: OUTPUT_TRANSFER_ID,
						role: 'observation-artifact',
						method: 'PUT',
					},
					null,
				),
			expected: 'TRACKING_ARTIFACT_INVALID',
		},
	] as const)('rejects $name', async ({ makeStatus, expected }) => {
		const value = coreWorkflowFixture();
		value.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value: makeStatus(submission),
		}));
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(
			new TrackingWorkflowError(
				expected as 'TRACKING_PROVIDER_FAILED' | 'TRACKING_ARTIFACT_INVALID',
			),
		);
	});

	test('rejects a provider state regression from output-ready authority', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'output-ready',
			progress: 90,
			safeFailureCode: null,
		});
		value.provider.status.mockImplementation(async (identity) => ({
			ok: true,
			value: status(
				identity,
				'transfer-grant-required',
				90,
				{
					transferRequestId: PREPARED_TRANSFER_ID,
					role: 'prepared-media',
					method: 'GET',
				},
				null,
			),
		}));
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_PROVIDER_FAILED'));
	});

	test('rejects completed output without its D1-authorized transfer identity', async () => {
		const value = coreWorkflowFixture();
		value.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value: completedStatusFixture(submission),
		}));
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_ARTIFACT_INVALID'));
		expect(value.publication.publish).not.toHaveBeenCalled();
	});

	test('maps artifact-publication failures to one safe code', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'output-ready',
			progress: 90,
			safeFailureCode: null,
		});
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.provider.status.mockImplementation(async (identity) => ({
			ok: true,
			value: completedStatusFixture(identity as TrackingJobSubmission),
		}));
		value.publication.publish.mockRejectedValue(
			new Error('private R2 validation detail'),
		);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_ARTIFACT_INVALID'));
		expect(value.authority.transitionAttempt).toHaveBeenLastCalledWith(
			expect.objectContaining({
				nextState: 'failed',
				safeFailureCode: 'TRACKING_ARTIFACT_INVALID',
			}),
		);
	});

	test('does not rewrite stale publication authority as an artifact failure', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'output-ready',
			progress: 90,
			safeFailureCode: null,
		});
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.provider.status.mockImplementation(async (identity) => ({
			ok: true,
			value: completedStatusFixture(identity as TrackingJobSubmission),
		}));
		value.publication.publish.mockRejectedValue(
			new TrackingArtifactPublicationError('STALE_AUTHORITY'),
		);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'));
		expect(value.authority.transitionAttempt).not.toHaveBeenCalledWith(
			expect.objectContaining({ nextState: 'failed' }),
		);
		expect(value.coordinator.release).not.toHaveBeenCalled();
	});

	test.each([
		{
			code: 'STALE_AUTHORITY' as const,
			expected: 'TRACKING_AUTHORITY_STALE' as const,
		},
		{
			code: 'INVALID_ARTIFACT' as const,
			expected: 'TRACKING_ARTIFACT_INVALID' as const,
		},
	])(
		'fails closed when accepted evidence commit reports $code',
		async ({ code, expected }) => {
			const value = coreWorkflowFixture({
				attemptId: ATTEMPT_ID,
				leaseId: LEASE_ID,
				fence: 7,
				state: 'output-ready',
				progress: 90,
				safeFailureCode: null,
			});
			value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
			value.provider.status.mockImplementation(async (identity) => ({
				ok: true,
				value: completedStatusFixture(identity as TrackingJobSubmission),
			}));
			value.evidence.commit.mockRejectedValue(
				new AcceptedCornerEvidenceError(code),
			);
			await expect(
				value.workflow.run(
					workflowEvent(),
					value.steps as unknown as WorkflowStep,
				),
			).rejects.toEqual(new TrackingWorkflowError(expected));
			expect(value.publication.publish).toHaveBeenCalledOnce();
			expect(value.publishAnalysisState).not.toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.objectContaining({ lifecycle: 'completed' }),
			);
			expect(value.authority.transitionAttempt).not.toHaveBeenCalledWith(
				expect.objectContaining({ nextState: 'failed' }),
			);
		},
	);

	test('keeps accepted-evidence infrastructure failures retryable', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'output-ready',
			progress: 90,
			safeFailureCode: null,
		});
		value.getContext().outputTransferRequestId = OUTPUT_TRANSFER_ID;
		value.provider.status.mockImplementation(async (identity) => ({
			ok: true,
			value: completedStatusFixture(identity as TrackingJobSubmission),
		}));
		const failure = new AcceptedCornerEvidenceError('RETRYABLE_INFRASTRUCTURE');
		value.evidence.commit.mockRejectedValue(failure);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(failure);
		expect(value.publication.publish).toHaveBeenCalledOnce();
		expect(value.publishAnalysisState).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ lifecycle: 'completed' }),
		);
		expect(value.authority.transitionAttempt).not.toHaveBeenCalledWith(
			expect.objectContaining({ nextState: 'failed' }),
		);
	});

	test.each(['ok', 'stale'] as const)(
		'accepted replay requires a completed release receipt: %s',
		async (status) => {
			const value = coreWorkflowFixture({
				attemptId: ATTEMPT_ID,
				leaseId: LEASE_ID,
				fence: 7,
				state: 'completed',
				progress: 99,
				safeFailureCode: null,
			});
			value.getContext().acceptedArtifactId = ATTEMPT_ID;
			value.coordinator.release.mockResolvedValue({ status });
			const running = value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			);
			if (status === 'ok')
				await expect(running).resolves.toMatchObject({
					state: { progress: 99 },
				});
			else {
				await expect(running).rejects.toMatchObject({
					code: 'TRACKING_AUTHORITY_STALE',
				});
				expect(value.evidence.commit).not.toHaveBeenCalled();
				expect(value.publishAnalysisState).not.toHaveBeenCalled();
			}
			expect(value.coordinator.release).toHaveBeenCalledWith(
				expect.objectContaining({
					completed: true,
					leaseId: LEASE_ID,
					fence: 7,
				}),
			);
		},
	);

	test('replays immutable accepted evidence before publishing Tracking state', async () => {
		const value = coreWorkflowFixture();
		value.getContext().acceptedArtifactId = ATTEMPT_ID;
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).resolves.toMatchObject({ state: { progress: 99 } });
		expect(value.evidence.commit).toHaveBeenCalledWith({
			ownerId: OWNER_ID,
			analysisId: ANALYSIS_ID,
			runId: RUN_ID,
			workflowId: WORKFLOW_ID,
			segmentId: SEGMENT_ID,
		});
		expect(value.provider.submit).not.toHaveBeenCalled();
		expect(value.publishAnalysisState).toHaveBeenCalledOnce();
	});

	test('normalizes an unexpected grant-authority exception', async () => {
		const value = coreWorkflowFixture();
		value.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value: status(
				submission,
				'transfer-grant-required',
				0,
				{
					transferRequestId: PREPARED_TRANSFER_ID,
					role: 'prepared-media',
					method: 'GET',
				},
				null,
			),
		}));
		value.grants.issue.mockRejectedValue(
			new Error('private signing exception'),
		);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_PROVIDER_FAILED'));
	});

	test('does not rewrite stale grant authority as a provider failure', async () => {
		const value = coreWorkflowFixture();
		value.provider.submit.mockImplementation(async (submission) => ({
			ok: true,
			value: status(
				submission,
				'transfer-grant-required',
				0,
				{
					transferRequestId: PREPARED_TRANSFER_ID,
					role: 'prepared-media',
					method: 'GET',
				},
				null,
			),
		}));
		value.grants.issue.mockRejectedValue(
			new TrackingTransferGrantError('LEASE_MISMATCH'),
		);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'));
		expect(value.authority.transitionAttempt).not.toHaveBeenCalledWith(
			expect.objectContaining({ nextState: 'failed' }),
		);
		expect(value.coordinator.release).not.toHaveBeenCalled();
	});

	test('rejects changed D1 authority between resume witness and provider contact', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'active',
			progress: 0,
			safeFailureCode: null,
		});
		value.coordinator.witness.mockImplementationOnce(async () => {
			const context = value.getContext();
			if (!context.attempt) throw new Error('missing attempt');
			context.attempt.leaseId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
			return { status: 'ok' };
		});
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'));
		expect(value.provider.submit).not.toHaveBeenCalled();
		expect(value.authority.transitionAttempt).not.toHaveBeenCalledWith(
			expect.objectContaining({ nextState: 'failed' }),
		);
	});

	test.each([
		{
			config: {
				GPU_ACCESS_CLIENT_ID: 'id',
				GPU_ACCESS_CLIENT_SECRET: 'secret',
			},
			expected: 'GPU provider origin is invalid',
		},
		{
			config: {
				GPU_PROVIDER_ORIGIN: 'https://gpu.chassisnotes.com',
				GPU_ACCESS_CLIENT_SECRET: 'secret',
			},
			expected: 'GPU provider Access credential is invalid',
		},
		{
			config: {
				GPU_PROVIDER_ORIGIN: 'https://gpu.chassisnotes.com',
				GPU_ACCESS_CLIENT_ID: 'id',
			},
			expected: 'GPU provider Access credential is invalid',
		},
	] as const)(
		'fails startup when provider deployment configuration is incomplete',
		async ({ config, expected }) => {
			const coordinator = new CoordinatorFixture({} as TrackingAuthority);
			const environment: DrivingAnalysisWorkflowEnvironment = {
				DB: {} as D1Database,
				ANALYSIS_MEDIA: {} as R2Bucket,
				GPU_LEASE_COORDINATOR: { getByName: () => coordinator },
				R2_ACCOUNT_ID: 'a'.repeat(32),
				R2_ACCESS_KEY_ID: 'access-key',
				R2_SECRET_ACCESS_KEY: 'secret-key',
				...config,
			};
			expect(() => firstTrackingSegmentWorkflow(environment)).toThrow(expected);
		},
	);

	test('redacts an internal failure while recording the safe failure', async () => {
		const value = coreWorkflowFixture({
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			state: 'active',
			progress: 0,
			safeFailureCode: null,
		});
		delete (value.coordinator as { requeueProviderLoss?: unknown })
			.requeueProviderLoss;
		value.authority.workflowContext
			.mockResolvedValueOnce(value.getContext())
			.mockRejectedValue(new Error('private persistence detail'));
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(new TrackingWorkflowError('TRACKING_AUTHORITY_STALE'));
	});
});
