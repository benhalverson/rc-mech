import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
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
]
	.map((name) => readFileSync(resolve(migrationDirectory, name), 'utf8'))
	.join('\n');

let sqlite: SqliteD1Fixture | undefined;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	sqlite?.close();
	sqlite = undefined;
});

class WorkflowStepFixture {
	readonly names: string[] = [];
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
		const attemptLimit = configuration?.retries?.limit ?? 5;
		let failure: unknown;
		for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
			try {
				const output = await callback();
				this.outputs.set(name, output);
				return output;
			} catch (error) {
				const delay = configuration?.retries?.delay;
				if (delay) delay({ ctx: { attempt: attempt + 1 } });
				failure = error;
			}
		}
		throw failure;
	}

	async sleep(name: string): Promise<void> {
		this.names.push(name);
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

const completedStatusFixture = (
	submission: TrackingJobSubmission,
): JobStatus => {
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
		publicState: vi.fn(async () => ({
			runId: RUN_ID,
			lifecycle: 'running' as const,
			stage: 'tracking' as const,
			progress: 99,
			waitReason: null,
			safeFailureCode: null,
		})),
		publicProvenance: vi.fn(async () => ({
			runId: RUN_ID,
			profileDigest: PROFILE_DIGEST,
			segments: [],
		})),
	};
	const coordinator = {
		enqueue: vi.fn<
			(input: GpuLeaseEnqueueInput) => Promise<GpuLeaseEnqueueResult>
		>(async () => ({ status: 'enqueued' })),
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
		).toMatchObject({ retries: { limit: 1 }, timeout: '30 seconds' });
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

	test('replaces an attempt when polling loses the provider', async () => {
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
		expect(value.provider.status).toHaveBeenCalledOnce();
		expect(value.authority.retireAttempt).toHaveBeenCalledOnce();
	});

	test('fails safely when provider-loss requeue is fenced by a newer lease', async () => {
		const value = coreWorkflowFixture();
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
		expect(value.authority.transitionAttempt).toHaveBeenLastCalledWith(
			expect.objectContaining({
				nextState: 'failed',
				safeFailureCode: 'TRACKING_PROVIDER_UNAVAILABLE',
			}),
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
		expect(value.authority.activateAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ expectedCurrentAttemptId: ATTEMPT_ID }),
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

	test('keeps D1 safely queued after the single capacity attempt is unavailable', async () => {
		const { authority, database } = await prepareAuthority();
		const coordinator = new CoordinatorFixture(authority);
		vi.spyOn(coordinator, 'acquire').mockResolvedValue({ status: 'busy' });
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
			lifecycle: 'queued',
			stage: 'tracking',
			progress: 0,
			waitReason: 'waiting-for-capacity',
			safeFailureCode: null,
		});
	});

	test('retries an idempotent D1 activation without retrying provider contact', async () => {
		const value = coreWorkflowFixture();
		value.authority.activateAttempt.mockRejectedValueOnce(
			new Error('transient D1 failure'),
		);
		await expect(
			value.workflow.run(
				workflowEvent(),
				value.steps as unknown as WorkflowStep,
			),
		).rejects.toEqual(
			new TrackingWorkflowError('TRACKING_PROVIDER_UNAVAILABLE'),
		);
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

	test('never contacts the provider after a stale lease witness', async () => {
		const value = coreWorkflowFixture();
		value.coordinator.witness.mockResolvedValue({ status: 'stale' });
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
			expect(value.publishAnalysisState).not.toHaveBeenCalled();
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
		expect(value.publishAnalysisState).not.toHaveBeenCalled();
		expect(value.authority.transitionAttempt).not.toHaveBeenCalledWith(
			expect.objectContaining({ nextState: 'failed' }),
		);
	});

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
