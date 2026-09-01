import {
	and,
	asc,
	eq,
	exists,
	inArray,
	isNull,
	lte,
	notExists,
	or,
	sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
	type AcceptTrackingArtifactCommand,
	type ActivateTrackingAttemptCommand,
	acceptTrackingArtifactCommandSchema,
	activateTrackingAttemptCommandSchema,
	type CreateFirstTrackingSegmentCommand,
	type CreateTrackingRunCommand,
	type CreateTrackingSegmentCommand,
	createFirstTrackingSegmentCommandSchema,
	createTrackingRunCommandSchema,
	createTrackingSegmentCommandSchema,
	type FenceTrackingRunCommand,
	fenceTrackingRunCommandSchema,
	type MarkTrackingArtifactPromotionDeletedCommand,
	type MarkTrackingArtifactPromotionReadyCommand,
	markTrackingArtifactPromotionDeletedCommandSchema,
	markTrackingArtifactPromotionReadyCommandSchema,
	type PrepareTrackingArtifactPublicationCommand,
	type PrepareTrackingTransferGrantCommand,
	type PublicTrackingProvenance,
	type PublicTrackingState,
	prepareTrackingArtifactPublicationCommandSchema,
	prepareTrackingTransferGrantCommandSchema,
	publicTrackingProvenanceSchema,
	publicTrackingStateSchema,
	type RecordTrackingArtifactPromotionCommand,
	type RecordTrackingTransferRequestCommand,
	type RetireTrackingAttemptCommand,
	recordTrackingArtifactPromotionCommandSchema,
	recordTrackingTransferRequestCommandSchema,
	retireTrackingAttemptCommandSchema,
	type TrackingWorkflowIdentity,
	type TransitionTrackingAttemptCommand,
	type TransitionTrackingTransferRequestCommand,
	trackingGapSchema,
	trackingWorkflowIdentitySchema,
	transitionTrackingAttemptCommandSchema,
	transitionTrackingTransferRequestCommandSchema,
} from './authority-contracts';
import {
	inferenceProfileAuthority,
	preparedTrackingMedia,
	preparedTrackingObject,
	preparedTrackingRetention,
	subjectObservationArtifact,
	trackingArtifactPromotion,
	trackingAuthoritySchema,
	trackingExecutionAttempt,
	trackingPublicProvenance,
	trackingRun,
	trackingRunInput,
	trackingSegment,
	trackingTransferRequest,
} from './authority-schema';
import {
	type PreparedMediaArtifact,
	preparedMediaArtifactSchema,
	type SubjectSeed,
	subjectSeedSchema,
} from './contracts';
import {
	digestInferenceProfile,
	type InferenceProfile,
	inferenceProfileSchema,
} from './inference-profile';
import {
	FRAME_MANIFEST_CONTENT_TYPE,
	PREPARED_MEDIA_CONTENT_TYPE,
} from './track-view-contracts';
import { buildTrackingSegmentSpecification } from './tracking-segment-specification';

export type TrackingAuthorityErrorCode =
	| 'NOT_FOUND'
	| 'CONFLICT'
	| 'STALE_AUTHORITY'
	| 'INVALID_TRANSITION';

export class TrackingAuthorityError extends Error {
	constructor(
		readonly code: TrackingAuthorityErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'TrackingAuthorityError';
	}
}

type TrackingRunRecord = typeof trackingRun.$inferSelect;
type TrackingSegmentRecord = typeof trackingSegment.$inferSelect;
type TrackingAttemptRecord = typeof trackingExecutionAttempt.$inferSelect;
type TrackingAttemptSummary = Pick<
	TrackingAttemptRecord,
	'id' | 'state' | 'progress' | 'safeFailureCode' | 'createdAt'
>;
type TrackingTransferRequestRecord =
	typeof trackingTransferRequest.$inferSelect;
export type SubjectObservationArtifactRecord =
	typeof subjectObservationArtifact.$inferSelect;
export type TrackingArtifactPromotionRecord =
	typeof trackingArtifactPromotion.$inferSelect;

export type TrackingArtifactPublicationContext = {
	prepared: PreparedMediaArtifact;
	profile: InferenceProfile;
	seed: SubjectSeed;
};

export type TrackingArtifactCleanupCandidate = Pick<
	TrackingArtifactPromotionRecord,
	'artifactId' | 'acceptedObjectKey' | 'version' | 'state'
>;

export type TrackingTransferGrantContext = {
	objectKey: string;
	contentType: string;
	role: PrepareTrackingTransferGrantCommand['role'];
	method: PrepareTrackingTransferGrantCommand['method'];
};

export type TrackingWorkflowContext = {
	ownerId: string;
	runId: string;
	analysisId: string;
	workflowId: string;
	profileDigest: string;
	segmentId: string;
	preparedMediaId: string;
	specificationDigest: string;
	availabilityDeadlineAt: number;
	outcome: 'completed' | 'tracking-gap' | null;
	acceptedArtifactId: string | null;
	outputTransferRequestId: string | null;
	prepared: PreparedMediaArtifact;
	profile: InferenceProfile;
	seed: SubjectSeed;
	attempt: {
		attemptId: string;
		leaseId: string;
		fence: number;
		state: TrackingAttemptRecord['state'];
		progress: number;
		safeFailureCode: string | null;
	} | null;
};

const MUTABLE_ATTEMPT_STATES = [
	'active',
	'transferring',
	'processing',
	'output-ready',
] as const;

const ALLOWED_ATTEMPT_TRANSITIONS: Readonly<
	Record<(typeof MUTABLE_ATTEMPT_STATES)[number], readonly string[]>
> = {
	active: [
		'transferring',
		'processing',
		'failed',
		'cancelled',
		'expired',
		'replaced',
	],
	transferring: ['processing', 'failed', 'cancelled', 'expired', 'replaced'],
	processing: ['output-ready', 'failed', 'cancelled', 'expired', 'replaced'],
	'output-ready': ['failed', 'cancelled', 'expired', 'replaced'],
};

export class TrackingAuthority {
	private readonly database;

	constructor(binding: D1Database) {
		this.database = drizzle(binding, { schema: trackingAuthoritySchema });
	}

	async createRun(
		commandValue: CreateTrackingRunCommand,
	): Promise<TrackingRunRecord> {
		const command = createTrackingRunCommandSchema.parse(commandValue);
		const profile = inferenceProfileSchema.parse(command.profile);
		const profileDigest = await digestInferenceProfile(profile);
		const configurationJson = JSON.stringify(profile);
		await this.database.batch([
			this.database
				.insert(inferenceProfileAuthority)
				.values({
					profileDigest,
					contractVersion: profile.contractVersion,
					canonicalizationVersion: profile.canonicalizationVersion,
					configurationJson,
					createdAt: command.createdAt,
				})
				.onConflictDoNothing(),
			this.database
				.insert(trackingRun)
				.values({
					id: command.runId,
					analysisId: command.analysisId,
					ownerId: command.ownerId,
					sequence: command.sequence,
					workflowId: command.workflowId,
					profileDigest,
					inputDigest: command.inputDigest,
					status: 'active',
					version: 1,
					createdAt: command.createdAt,
				})
				.onConflictDoNothing(),
		]);
		const [storedProfile, storedRun] = await Promise.all([
			this.database
				.select()
				.from(inferenceProfileAuthority)
				.where(eq(inferenceProfileAuthority.profileDigest, profileDigest))
				.get(),
			this.database
				.select()
				.from(trackingRun)
				.where(
					and(
						eq(trackingRun.ownerId, command.ownerId),
						or(
							eq(trackingRun.id, command.runId),
							and(
								eq(trackingRun.analysisId, command.analysisId),
								eq(trackingRun.sequence, command.sequence),
							),
						),
					),
				)
				.get(),
		]);
		if (!storedProfile || storedProfile.configurationJson !== configurationJson)
			throw conflict('Inference-profile digest does not identify one profile');
		if (!storedRun)
			throw notFound('Tracking run was not created for this owner');
		if (
			storedRun.id !== command.runId ||
			storedRun.analysisId !== command.analysisId ||
			storedRun.sequence !== command.sequence ||
			storedRun.workflowId !== command.workflowId ||
			storedRun.profileDigest !== profileDigest ||
			storedRun.inputDigest !== command.inputDigest ||
			storedRun.createdAt !== command.createdAt
		)
			throw conflict(
				'Tracking run identity was replayed with different immutable input',
			);
		return storedRun;
	}

	async createSegment(
		commandValue: CreateTrackingSegmentCommand,
	): Promise<TrackingSegmentRecord> {
		const command = createTrackingSegmentCommandSchema.parse(commandValue);
		const run = await this.requireActiveRun(command.ownerId, command.runId);
		const [preparedRecord, input, objects, retention] = await Promise.all([
			this.database
				.select()
				.from(preparedTrackingMedia)
				.where(
					and(
						eq(preparedTrackingMedia.id, command.preparedMediaId),
						eq(preparedTrackingMedia.runId, command.runId),
					),
				)
				.get(),
			this.database
				.select()
				.from(trackingRunInput)
				.where(
					and(
						eq(trackingRunInput.runId, command.runId),
						eq(trackingRunInput.ownerId, command.ownerId),
					),
				)
				.get(),
			this.database
				.select()
				.from(preparedTrackingObject)
				.where(
					eq(preparedTrackingObject.preparedMediaId, command.preparedMediaId),
				)
				.orderBy(asc(preparedTrackingObject.role)),
			this.database
				.select()
				.from(preparedTrackingRetention)
				.where(
					and(
						eq(preparedTrackingRetention.runId, command.runId),
						eq(
							preparedTrackingRetention.preparedMediaId,
							command.preparedMediaId,
						),
						eq(preparedTrackingRetention.state, 'active'),
					),
				)
				.get(),
		]);
		if (!preparedRecord || !input || !retention || objects.length !== 2)
			throw notFound('Accepted prepared Track view was not found for this run');
		const prepared = preparedMediaArtifactSchema.parse(
			JSON.parse(preparedRecord.descriptorJson),
		);
		const manifest = objects[0];
		const media = objects[1];
		/* c8 ignore next 19 -- the typed prepared-view authority validates this tuple before its one immutable D1 commit; this remains a corruption defense at the consumer boundary. */
		if (
			input.inputDigest !== run.inputDigest ||
			prepared.preparationInputDigest !== input.inputDigest ||
			prepared.sourceByteCount !== input.sourceByteCount ||
			prepared.sourceChecksumSha256 !== input.sourceChecksum ||
			prepared.window.startTimestampMs !== input.windowStartTimestampMs ||
			prepared.window.endTimestampMs !== input.windowEndTimestampMs ||
			manifest?.role !== 'frame-manifest' ||
			manifest.byteCount !== prepared.frameManifestByteCount ||
			manifest.checksumSha256 !== prepared.frameManifestChecksumSha256 ||
			manifest.contentType !== FRAME_MANIFEST_CONTENT_TYPE ||
			manifest.contentEncoding !== 'gzip' ||
			media?.role !== 'prepared-media' ||
			media.byteCount !== prepared.byteCount ||
			media.checksumSha256 !== prepared.checksumSha256 ||
			media.contentType !== PREPARED_MEDIA_CONTENT_TYPE ||
			media.contentEncoding !== null
		)
			throw conflict('Prepared Track-view authority is inconsistent');
		if (
			command.seed.value.timestampMs < prepared.window.startTimestampMs ||
			command.seed.value.timestampMs >= prepared.window.endTimestampMs ||
			(command.seed.kind === 'initial'
				? command.order !== 0
				: command.order === 0)
		)
			throw conflict('Tracking-segment seed does not match its run boundary');
		const specification = await buildTrackingSegmentSpecification(
			command,
			prepared,
			run.profileDigest,
		);
		const seedJson = JSON.stringify(command.seed.value);
		await this.database
			.insert(trackingSegment)
			.values({
				id: command.segmentId,
				runId: command.runId,
				order: command.order,
				seedKind: command.seed.kind,
				seedSourceId: command.seed.sourceId,
				seedJson,
				preparedMediaId: command.preparedMediaId,
				raceWindowEndTimestampMs: specification.raceWindowEndTimestampMs,
				profileDigest: run.profileDigest,
				specificationVersion: command.specificationVersion,
				specificationDigest: specification.digest,
				availabilityDeadlineAt: command.availabilityDeadlineAt,
				version: 1,
				createdAt: command.createdAt,
			})
			.onConflictDoNothing();
		const stored = await this.database
			.select()
			.from(trackingSegment)
			.where(
				and(
					eq(trackingSegment.runId, command.runId),
					or(
						eq(trackingSegment.id, command.segmentId),
						eq(trackingSegment.order, command.order),
						eq(trackingSegment.specificationDigest, specification.digest),
					),
				),
			)
			.get();
		/* c8 ignore next -- an insert-or-existing D1 write always yields one matching identity unless D1 fails. */
		if (!stored) throw conflict('Tracking segment was not persisted');
		if (
			stored.id !== command.segmentId ||
			stored.seedKind !== command.seed.kind ||
			stored.seedSourceId !== command.seed.sourceId ||
			stored.seedJson !== seedJson ||
			stored.preparedMediaId !== command.preparedMediaId ||
			stored.profileDigest !== run.profileDigest ||
			stored.specificationDigest !== specification.digest ||
			stored.availabilityDeadlineAt !== command.availabilityDeadlineAt ||
			stored.createdAt !== command.createdAt
		)
			throw conflict(
				'Tracking-segment identity was replayed with different immutable input',
			);
		return stored;
	}

	async createFirstSegment(
		commandValue: CreateFirstTrackingSegmentCommand,
	): Promise<TrackingWorkflowContext> {
		const command = createFirstTrackingSegmentCommandSchema.parse(commandValue);
		const run = await this.requireActiveRun(command.ownerId, command.runId);
		if (
			run.analysisId !== command.analysisId ||
			run.workflowId !== command.workflowId
		)
			throw stale('Tracking Workflow does not own the current run');
		if (command.order !== 0 || command.seed.kind !== 'initial')
			throw conflict('The first Tracking segment must use the initial seed');
		const {
			analysisId: _analysisId,
			workflowId: _workflowId,
			...segment
		} = command;
		await this.createSegment(segment);
		return this.workflowContext({
			ownerId: command.ownerId,
			analysisId: command.analysisId,
			runId: command.runId,
			workflowId: command.workflowId,
			segmentId: command.segmentId,
		});
	}

	async workflowContext(
		identityValue: TrackingWorkflowIdentity,
	): Promise<TrackingWorkflowContext> {
		const identity = trackingWorkflowIdentitySchema.parse(identityValue);
		const run = await this.requireActiveRun(identity.ownerId, identity.runId);
		if (
			run.analysisId !== identity.analysisId ||
			run.workflowId !== identity.workflowId
		)
			throw stale('Tracking Workflow does not own the current run');
		const segment = await this.ownedSegment(identity.runId, identity.segmentId);
		if (segment?.order !== 0 || segment.seedKind !== 'initial')
			throw notFound('The first Tracking segment was not found');
		const [prepared, profile, attempt, outputTransfer] = await Promise.all([
			this.database
				.select()
				.from(preparedTrackingMedia)
				.where(
					and(
						eq(preparedTrackingMedia.id, segment.preparedMediaId),
						eq(preparedTrackingMedia.runId, identity.runId),
					),
				)
				.get(),
			this.database
				.select()
				.from(inferenceProfileAuthority)
				.where(
					eq(inferenceProfileAuthority.profileDigest, segment.profileDigest),
				)
				.get(),
			segment.currentAttemptId === null
				? Promise.resolve(undefined)
				: this.database
						.select()
						.from(trackingExecutionAttempt)
						.where(eq(trackingExecutionAttempt.id, segment.currentAttemptId))
						.get(),
			segment.currentAttemptId === null
				? Promise.resolve(undefined)
				: this.database
						.select({ id: trackingTransferRequest.id })
						.from(trackingTransferRequest)
						.where(
							and(
								eq(trackingTransferRequest.attemptId, segment.currentAttemptId),
								eq(trackingTransferRequest.role, 'observation-artifact'),
							),
						)
						.get(),
		]);
		/* c8 ignore next 2 -- accepted prepared and attempt foreign-key authority make these corruption-only states. */
		if (
			!prepared ||
			!profile ||
			(segment.currentAttemptId !== null && !attempt)
		)
			throw conflict('Tracking Workflow authority is inconsistent');
		return {
			ownerId: run.ownerId,
			runId: run.id,
			analysisId: run.analysisId,
			workflowId: run.workflowId,
			profileDigest: segment.profileDigest,
			segmentId: segment.id,
			preparedMediaId: segment.preparedMediaId,
			specificationDigest: segment.specificationDigest,
			availabilityDeadlineAt: segment.availabilityDeadlineAt,
			outcome: segment.outcome,
			acceptedArtifactId: segment.acceptedArtifactId,
			outputTransferRequestId: outputTransfer?.id ?? null,
			prepared: preparedMediaArtifactSchema.parse(
				JSON.parse(prepared.descriptorJson),
			),
			profile: inferenceProfileSchema.parse(
				JSON.parse(profile.configurationJson),
			),
			seed: subjectSeedSchema.parse(JSON.parse(segment.seedJson)),
			attempt: attempt
				? {
						attemptId: attempt.id,
						leaseId: attempt.leaseId,
						fence: attempt.fence,
						state: attempt.state,
						progress: attempt.progress,
						safeFailureCode: attempt.safeFailureCode,
					}
				: null,
		};
	}

	async activateAttempt(
		commandValue: ActivateTrackingAttemptCommand,
	): Promise<TrackingAttemptRecord> {
		const command = activateTrackingAttemptCommandSchema.parse(commandValue);
		await this.requireActiveRun(command.ownerId, command.runId);
		const segment = await this.ownedSegment(command.runId, command.segmentId);
		if (!segment) throw notFound('Tracking segment was not found');
		const existing = await this.database
			.select()
			.from(trackingExecutionAttempt)
			.where(eq(trackingExecutionAttempt.id, command.attemptId))
			.get();
		if (existing) {
			this.assertAttemptIdentity(existing, segment, command);
			if (
				segment.currentAttemptId === command.attemptId &&
				existing.state !== 'proposed'
			)
				return existing;
			throw stale('Tracking attempt did not acquire current authority');
		}
		if (
			segment.outcome !== null ||
			segment.currentAttemptId !== command.expectedCurrentAttemptId ||
			(segment.authorityFence !== null &&
				command.fence <= segment.authorityFence)
		)
			throw stale('Tracking-segment authority witness is stale');
		const currentAttemptWitness =
			command.expectedCurrentAttemptId === null
				? isNull(trackingSegment.currentAttemptId)
				: eq(
						trackingSegment.currentAttemptId,
						command.expectedCurrentAttemptId,
					);
		const runIsCurrent = exists(
			this.database
				.select({ id: trackingRun.id })
				.from(trackingRun)
				.where(
					and(
						eq(trackingRun.id, command.runId),
						eq(trackingRun.ownerId, command.ownerId),
						eq(trackingRun.status, 'active'),
					),
				),
		);
		await this.database.batch([
			this.database
				.insert(trackingExecutionAttempt)
				.values({
					id: command.attemptId,
					segmentId: command.segmentId,
					profileDigest: segment.profileDigest,
					specificationDigest: segment.specificationDigest,
					leaseId: command.leaseId,
					fence: command.fence,
					state: 'proposed',
					progress: 0,
					version: 1,
					createdAt: command.createdAt,
					updatedAt: command.createdAt,
				})
				.onConflictDoNothing(),
			this.database
				.update(trackingSegment)
				.set({
					currentAttemptId: command.attemptId,
					authorityLeaseId: command.leaseId,
					authorityFence: command.fence,
					version: segment.version + 1,
				})
				.where(
					and(
						eq(trackingSegment.id, command.segmentId),
						eq(trackingSegment.runId, command.runId),
						eq(trackingSegment.version, segment.version),
						currentAttemptWitness,
						isNull(trackingSegment.outcome),
						runIsCurrent,
					),
				),
			this.database
				.update(trackingExecutionAttempt)
				.set({
					state: 'active',
					version: 2,
					updatedAt: command.createdAt,
				})
				.where(
					and(
						eq(trackingExecutionAttempt.id, command.attemptId),
						eq(trackingExecutionAttempt.segmentId, command.segmentId),
						eq(trackingExecutionAttempt.leaseId, command.leaseId),
						eq(trackingExecutionAttempt.fence, command.fence),
						eq(trackingExecutionAttempt.state, 'proposed'),
						exists(
							this.database
								.select({ id: trackingSegment.id })
								.from(trackingSegment)
								.where(
									and(
										eq(trackingSegment.id, command.segmentId),
										eq(trackingSegment.currentAttemptId, command.attemptId),
										eq(trackingSegment.authorityLeaseId, command.leaseId),
										eq(trackingSegment.authorityFence, command.fence),
									),
								),
						),
					),
				),
		]);
		const [activated, current] = await Promise.all([
			this.database
				.select()
				.from(trackingExecutionAttempt)
				.where(eq(trackingExecutionAttempt.id, command.attemptId))
				.get(),
			this.ownedSegment(command.runId, command.segmentId),
		]);
		/* c8 ignore next 2 -- these are post-batch D1 race defenses; the conditional-write behavior is exercised through the migration integration tests. */
		if (!activated || !current)
			throw stale('Tracking attempt was not activated');
		this.assertAttemptIdentity(activated, current, command);
		/* c8 ignore next 5 -- these are post-batch D1 race defenses; the conditional-write behavior is exercised through the migration integration tests. */
		if (
			activated.state !== 'active' ||
			current.currentAttemptId !== command.attemptId
		)
			throw stale('Tracking attempt lost its authority race');
		return activated;
	}

	async transitionAttempt(
		commandValue: TransitionTrackingAttemptCommand,
	): Promise<TrackingAttemptRecord> {
		const command = transitionTrackingAttemptCommandSchema.parse(commandValue);
		const attempt = await this.requireCurrentAttempt(command);
		if (
			attempt.state === command.nextState &&
			attempt.progress === command.progress &&
			attempt.safeFailureCode === command.safeFailureCode
		)
			return attempt;
		if (
			attempt.state !== command.expectedState ||
			(command.expectedState !== command.nextState &&
				!isAllowedAttemptTransition(
					command.expectedState,
					command.nextState,
				)) ||
			command.progress < attempt.progress ||
			(command.nextState === 'failed') !== (command.safeFailureCode !== null)
		)
			throw invalidTransition('Tracking-attempt transition is invalid');
		const updated = await this.database
			.update(trackingExecutionAttempt)
			.set({
				state: command.nextState,
				progress: command.progress,
				safeFailureCode: command.safeFailureCode,
				version: attempt.version + 1,
				updatedAt: command.updatedAt,
			})
			.where(
				and(
					eq(trackingExecutionAttempt.id, command.attemptId),
					eq(trackingExecutionAttempt.segmentId, command.segmentId),
					eq(trackingExecutionAttempt.leaseId, command.leaseId),
					eq(trackingExecutionAttempt.fence, command.fence),
					eq(trackingExecutionAttempt.state, command.expectedState),
					eq(trackingExecutionAttempt.version, attempt.version),
					this.currentAuthorityExists(command),
				),
			)
			.returning()
			.get();
		/* c8 ignore next -- a zero-row result requires a concurrent D1 witness change after the read above. */
		if (!updated) throw stale('Tracking-attempt authority changed');
		return updated;
	}

	/** Retire the current attempt and atomically remove its segment authority. */
	async retireAttempt(
		commandValue: RetireTrackingAttemptCommand,
	): Promise<void> {
		const command = retireTrackingAttemptCommandSchema.parse(commandValue);
		const attempt = await this.requireCurrentAttempt(command);
		await this.database.batch([
			this.database
				.update(trackingExecutionAttempt)
				.set({
					state: command.nextState,
					updatedAt: command.updatedAt,
					version: attempt.version + 1,
				})
				.where(
					and(
						eq(trackingExecutionAttempt.id, command.attemptId),
						eq(trackingExecutionAttempt.state, attempt.state),
						eq(trackingExecutionAttempt.version, attempt.version),
						this.currentAuthorityExists(command),
					),
				),
			this.database
				.update(trackingSegment)
				.set({
					currentAttemptId: null,
					authorityLeaseId: null,
					authorityFence: null,
					version: sql`${trackingSegment.version} + 1`,
				})
				.where(
					and(
						eq(trackingSegment.id, command.segmentId),
						eq(trackingSegment.currentAttemptId, command.attemptId),
						eq(trackingSegment.authorityLeaseId, command.leaseId),
						eq(trackingSegment.authorityFence, command.fence),
						isNull(trackingSegment.outcome),
					),
				),
		]);
		const segment = await this.ownedSegment(command.runId, command.segmentId);
		if (!segment || segment.currentAttemptId !== null)
			throw stale('Tracking attempt retirement lost its authority race');
	}

	async recordTransferRequest(
		commandValue: RecordTrackingTransferRequestCommand,
	): Promise<TrackingTransferRequestRecord> {
		const command =
			recordTrackingTransferRequestCommandSchema.parse(commandValue);
		await this.requireCurrentAttempt(command);
		await this.database
			.insert(trackingTransferRequest)
			.values({
				id: command.transferRequestId,
				attemptId: command.attemptId,
				role: command.role,
				method: command.method,
				objectScope: command.objectScope,
				state: 'required',
				version: 1,
				createdAt: command.createdAt,
				updatedAt: command.createdAt,
			})
			.onConflictDoNothing();
		const stored = await this.database
			.select()
			.from(trackingTransferRequest)
			.where(
				or(
					eq(trackingTransferRequest.id, command.transferRequestId),
					and(
						eq(trackingTransferRequest.attemptId, command.attemptId),
						eq(trackingTransferRequest.role, command.role),
					),
				),
			)
			.get();
		/* c8 ignore next -- an insert-or-existing D1 write always yields one matching identity unless D1 fails. */
		if (!stored) throw conflict('Tracking transfer request was not persisted');
		if (
			stored.id !== command.transferRequestId ||
			stored.attemptId !== command.attemptId ||
			stored.role !== command.role ||
			stored.method !== command.method ||
			stored.objectScope !== command.objectScope
		)
			throw conflict(
				'Transfer-request identity was replayed with different immutable scope',
			);
		return stored;
	}

	async prepareTransferGrant(
		commandValue: PrepareTrackingTransferGrantCommand,
	): Promise<TrackingTransferGrantContext> {
		const command =
			prepareTrackingTransferGrantCommandSchema.parse(commandValue);
		const attempt = await this.requireCurrentAttempt(command);
		const segment = await this.ownedSegment(command.runId, command.segmentId);
		/* c8 ignore next -- requireCurrentAttempt already proves the owned segment exists. */
		if (!segment) throw notFound('Tracking segment was not found');
		if (
			segment.profileDigest !== command.profileDigest ||
			segment.specificationDigest !== command.specificationDigest ||
			attempt.profileDigest !== command.profileDigest ||
			attempt.specificationDigest !== command.specificationDigest
		)
			throw stale('Tracking transfer identity is stale');
		if (
			command.role === 'observation-artifact'
				? attempt.state !== 'output-ready'
				: attempt.state !== 'active' && attempt.state !== 'transferring'
		)
			throw invalidTransition(
				'Tracking attempt cannot issue the requested transfer role',
			);

		const resolved =
			command.role === 'observation-artifact'
				? {
						objectScope: command.transferRequestId,
						objectKey: `tracking-staging/${command.attemptId}/${command.transferRequestId}/subject-observations.json.gz`,
						contentType: 'application/octet-stream',
					}
				: await this.preparedTransferObject(segment, command.role);
		await this.recordTransferRequest({
			ownerId: command.ownerId,
			runId: command.runId,
			segmentId: command.segmentId,
			attemptId: command.attemptId,
			leaseId: command.leaseId,
			fence: command.fence,
			transferRequestId: command.transferRequestId,
			role: command.role,
			method: command.method,
			objectScope: resolved.objectScope,
			createdAt: command.requestedAt,
		});
		return {
			objectKey: resolved.objectKey,
			contentType: resolved.contentType,
			role: command.role,
			method: command.method,
		};
	}

	async authorizeTransferGrant(
		commandValue: PrepareTrackingTransferGrantCommand,
	): Promise<TrackingTransferGrantContext> {
		const command =
			prepareTrackingTransferGrantCommandSchema.parse(commandValue);
		const context = await this.prepareTransferGrant(command);
		await this.transitionTransferRequest({
			ownerId: command.ownerId,
			runId: command.runId,
			segmentId: command.segmentId,
			attemptId: command.attemptId,
			leaseId: command.leaseId,
			fence: command.fence,
			transferRequestId: command.transferRequestId,
			expectedState: 'required',
			nextState: 'granted',
			updatedAt: command.requestedAt,
		});
		return context;
	}

	async transitionTransferRequest(
		commandValue: TransitionTrackingTransferRequestCommand,
	): Promise<TrackingTransferRequestRecord> {
		const command =
			transitionTrackingTransferRequestCommandSchema.parse(commandValue);
		await this.requireCurrentAttempt(command);
		const request = await this.database
			.select()
			.from(trackingTransferRequest)
			.where(
				and(
					eq(trackingTransferRequest.id, command.transferRequestId),
					eq(trackingTransferRequest.attemptId, command.attemptId),
				),
			)
			.get();
		if (!request) throw notFound('Tracking transfer request was not found');
		if (request.state === command.nextState) return request;
		if (
			request.state !== command.expectedState ||
			(command.expectedState === 'required'
				? command.nextState !== 'granted'
				: command.nextState !== 'completed')
		)
			throw invalidTransition('Transfer-request transition is invalid');
		const updated = await this.database
			.update(trackingTransferRequest)
			.set({
				state: command.nextState,
				version: request.version + 1,
				updatedAt: command.updatedAt,
			})
			.where(
				and(
					eq(trackingTransferRequest.id, command.transferRequestId),
					eq(trackingTransferRequest.attemptId, command.attemptId),
					eq(trackingTransferRequest.state, command.expectedState),
					eq(trackingTransferRequest.version, request.version),
					this.currentAuthorityExists(command),
				),
			)
			.returning()
			.get();
		/* c8 ignore next -- a zero-row result requires a concurrent D1 witness change after the read above. */
		if (!updated) throw stale('Transfer-request authority changed');
		return updated;
	}

	async prepareArtifactPublication(
		commandValue: PrepareTrackingArtifactPublicationCommand,
	): Promise<TrackingArtifactPublicationContext> {
		const command =
			prepareTrackingArtifactPublicationCommandSchema.parse(commandValue);
		const attempt = await this.requireCurrentAttempt(command);
		const segment = await this.ownedSegment(command.runId, command.segmentId);
		/* c8 ignore next -- requireCurrentAttempt already proves the owned segment exists. */
		if (!segment) throw notFound('Tracking segment was not found');
		if (
			attempt.state !== 'output-ready' ||
			segment.profileDigest !== command.profileDigest ||
			segment.specificationDigest !== command.specificationDigest ||
			attempt.profileDigest !== command.profileDigest ||
			attempt.specificationDigest !== command.specificationDigest
		)
			throw stale('Tracking artifact publication identity is stale');

		const [transfer, prepared, profile] = await Promise.all([
			this.database
				.select()
				.from(trackingTransferRequest)
				.where(
					and(
						eq(trackingTransferRequest.id, command.transferRequestId),
						eq(trackingTransferRequest.attemptId, command.attemptId),
					),
				)
				.get(),
			this.database
				.select()
				.from(preparedTrackingMedia)
				.where(
					and(
						eq(preparedTrackingMedia.id, segment.preparedMediaId),
						eq(preparedTrackingMedia.runId, command.runId),
					),
				)
				.get(),
			this.database
				.select()
				.from(inferenceProfileAuthority)
				.where(
					eq(inferenceProfileAuthority.profileDigest, command.profileDigest),
				)
				.get(),
		]);
		if (!transfer || !prepared || !profile)
			throw notFound('Tracking artifact publication context was not found');
		if (
			transfer.role !== 'observation-artifact' ||
			transfer.method !== 'PUT' ||
			transfer.objectScope !== command.transferRequestId ||
			transfer.state !== 'granted'
		)
			throw invalidTransition(
				'Tracking observation transfer is not ready for publication',
			);
		return {
			prepared: preparedMediaArtifactSchema.parse(
				JSON.parse(prepared.descriptorJson),
			),
			profile: inferenceProfileSchema.parse(
				JSON.parse(profile.configurationJson),
			),
			seed: subjectSeedSchema.parse(JSON.parse(segment.seedJson)),
		};
	}

	async recordArtifactPromotion(
		commandValue: RecordTrackingArtifactPromotionCommand,
	): Promise<TrackingArtifactPromotionRecord> {
		const command =
			recordTrackingArtifactPromotionCommandSchema.parse(commandValue);
		await this.prepareArtifactPublication({
			ownerId: command.ownerId,
			runId: command.runId,
			segmentId: command.segmentId,
			attemptId: command.attemptId,
			leaseId: command.leaseId,
			fence: command.fence,
			profileDigest: command.profileDigest,
			specificationDigest: command.specificationDigest,
			transferRequestId: command.transferRequestId,
		});
		await this.database
			.insert(trackingArtifactPromotion)
			.values({
				artifactId: command.artifactId,
				runId: command.runId,
				segmentId: command.segmentId,
				attemptId: command.attemptId,
				transferRequestId: command.transferRequestId,
				stagingObjectKey: command.stagingObjectKey,
				acceptedObjectKey: command.acceptedObjectKey,
				checksumSha256: command.checksumSha256,
				contractDigest: command.contractDigest,
				byteCount: command.byteCount,
				state: 'pending',
				deleteAfter: command.deleteAfter,
				version: 1,
				createdAt: command.createdAt,
				updatedAt: command.createdAt,
				deletedAt: null,
			})
			.onConflictDoNothing();
		const stored = await this.database
			.select()
			.from(trackingArtifactPromotion)
			.where(
				or(
					eq(trackingArtifactPromotion.artifactId, command.artifactId),
					eq(
						trackingArtifactPromotion.transferRequestId,
						command.transferRequestId,
					),
					eq(
						trackingArtifactPromotion.stagingObjectKey,
						command.stagingObjectKey,
					),
					eq(
						trackingArtifactPromotion.acceptedObjectKey,
						command.acceptedObjectKey,
					),
				),
			)
			.get();
		/* c8 ignore next -- an insert-or-existing D1 write always yields one matching identity unless D1 fails. */
		if (!stored)
			throw conflict('Tracking artifact promotion was not persisted');
		if (!promotionMatches(stored, command))
			throw conflict(
				'Tracking artifact promotion was replayed with different immutable input',
			);
		if (stored.state === 'deleting' || stored.state === 'deleted')
			throw stale('Tracking artifact promotion is no longer publishable');
		return stored;
	}

	async markArtifactPromotionReady(
		commandValue: MarkTrackingArtifactPromotionReadyCommand,
	): Promise<TrackingArtifactPromotionRecord> {
		const command =
			markTrackingArtifactPromotionReadyCommandSchema.parse(commandValue);
		await this.requireCurrentAttempt(command);
		const stored = await this.database
			.select()
			.from(trackingArtifactPromotion)
			.where(eq(trackingArtifactPromotion.artifactId, command.artifactId))
			.get();
		if (!stored) throw notFound('Tracking artifact promotion was not found');
		/* c8 ignore next 6 -- recordArtifactPromotion writes current authority identity and the migration makes every identity column immutable; this is corruption defense. */
		if (
			stored.runId !== command.runId ||
			stored.segmentId !== command.segmentId ||
			stored.attemptId !== command.attemptId
		)
			throw conflict('Tracking artifact promotion identity is inconsistent');
		if (stored.state === 'promoted' || stored.state === 'accepted')
			return stored;
		if (
			stored.state !== 'pending' ||
			stored.version !== command.expectedVersion
		)
			throw stale('Tracking artifact promotion authority changed');
		const updated = await this.database
			.update(trackingArtifactPromotion)
			.set({
				state: 'promoted',
				version: stored.version + 1,
				updatedAt: command.updatedAt,
			})
			.where(
				and(
					eq(trackingArtifactPromotion.artifactId, command.artifactId),
					eq(trackingArtifactPromotion.state, 'pending'),
					eq(trackingArtifactPromotion.version, stored.version),
					this.currentAuthorityExists(command),
				),
			)
			.returning()
			.get();
		/* c8 ignore next -- a zero-row result requires a concurrent D1 authority or cleanup change after the read above. */
		if (!updated) throw stale('Tracking artifact promotion authority changed');
		return updated;
	}

	async cleanupPromotionCandidates(
		now: string,
		limit = 50,
	): Promise<readonly TrackingArtifactCleanupCandidate[]> {
		if (Number.isNaN(Date.parse(now)))
			throw new RangeError('Cleanup time is invalid');
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new RangeError('Cleanup limit must be between 1 and 100');
		const unreferenced = notExists(
			this.database
				.select({ id: subjectObservationArtifact.id })
				.from(subjectObservationArtifact)
				.where(
					or(
						eq(
							subjectObservationArtifact.id,
							trackingArtifactPromotion.artifactId,
						),
						eq(
							subjectObservationArtifact.acceptedObjectKey,
							trackingArtifactPromotion.acceptedObjectKey,
						),
					),
				),
		);
		const due = await this.database
			.select()
			.from(trackingArtifactPromotion)
			.where(
				and(
					inArray(trackingArtifactPromotion.state, [
						'pending',
						'promoted',
						'deleting',
					]),
					lte(trackingArtifactPromotion.deleteAfter, now),
					unreferenced,
				),
			)
			.orderBy(asc(trackingArtifactPromotion.deleteAfter))
			.limit(limit);
		const claimed: TrackingArtifactCleanupCandidate[] = [];
		for (const candidate of due) {
			if (candidate.state === 'deleting') {
				claimed.push(candidate);
				continue;
			}
			const updated = await this.database
				.update(trackingArtifactPromotion)
				.set({
					state: 'deleting',
					version: candidate.version + 1,
					updatedAt: now,
				})
				.where(
					and(
						eq(trackingArtifactPromotion.artifactId, candidate.artifactId),
						inArray(trackingArtifactPromotion.state, ['pending', 'promoted']),
						eq(trackingArtifactPromotion.version, candidate.version),
						unreferenced,
					),
				)
				.returning()
				.get();
			/* c8 ignore next -- a zero-row result requires a concurrent D1 cleanup claim after the selected snapshot; skipping it is the safe outcome. */
			if (updated) claimed.push(updated);
		}
		return claimed;
	}

	async markArtifactPromotionDeleted(
		commandValue: MarkTrackingArtifactPromotionDeletedCommand,
	): Promise<TrackingArtifactPromotionRecord> {
		const command =
			markTrackingArtifactPromotionDeletedCommandSchema.parse(commandValue);
		const updated = await this.database
			.update(trackingArtifactPromotion)
			.set({
				state: 'deleted',
				version: command.expectedVersion + 1,
				updatedAt: command.deletedAt,
				deletedAt: command.deletedAt,
			})
			.where(
				and(
					eq(trackingArtifactPromotion.artifactId, command.artifactId),
					eq(trackingArtifactPromotion.state, 'deleting'),
					eq(trackingArtifactPromotion.version, command.expectedVersion),
					notExists(
						this.database
							.select({ id: subjectObservationArtifact.id })
							.from(subjectObservationArtifact)
							.where(eq(subjectObservationArtifact.id, command.artifactId)),
					),
				),
			)
			.returning()
			.get();
		if (updated) return updated;
		const stored = await this.database
			.select()
			.from(trackingArtifactPromotion)
			.where(eq(trackingArtifactPromotion.artifactId, command.artifactId))
			.get();
		if (
			stored?.state === 'deleted' &&
			stored.version === command.expectedVersion + 1 &&
			stored.deletedAt === command.deletedAt
		)
			return stored;
		throw stale('Tracking artifact cleanup authority changed');
	}

	async acceptedArtifactFor(
		ownerId: string,
		runId: string,
		segmentId: string,
	): Promise<SubjectObservationArtifactRecord | null> {
		await this.requireOwnedRun(ownerId, runId);
		const segment = await this.ownedSegment(runId, segmentId);
		if (!segment) throw notFound('Tracking segment was not found');
		if (segment.acceptedArtifactId === null) return null;
		const artifact = await this.acceptedArtifact(segment.acceptedArtifactId);
		/* c8 ignore next -- a segment can only bind an artifact inserted in the same D1 batch. */
		if (!artifact) throw conflict('Accepted Tracking artifact was not found');
		return artifact;
	}

	async acceptArtifact(
		commandValue: AcceptTrackingArtifactCommand,
	): Promise<SubjectObservationArtifactRecord> {
		const command = acceptTrackingArtifactCommandSchema.parse(commandValue);
		await this.requireOwnedRun(command.ownerId, command.runId);
		const segment = await this.ownedSegment(command.runId, command.segmentId);
		if (!segment) throw notFound('Tracking segment was not found');
		if (segment.acceptedArtifactId !== null) {
			const accepted = await this.acceptedArtifact(segment.acceptedArtifactId);
			if (accepted && artifactMatches(accepted, command)) return accepted;
			throw conflict(
				'Tracking segment already has different accepted evidence',
			);
		}
		await this.requireActiveRun(command.ownerId, command.runId);
		const attempt = await this.requireCurrentAttempt(command);
		if (attempt.state !== 'output-ready')
			throw invalidTransition('Tracking artifact is not output-ready');
		const gapJson = command.gap === null ? null : JSON.stringify(command.gap);
		const artifactSelection = this.database
			.select({
				id: sql<string>`${command.artifactId}`,
				runId: trackingSegment.runId,
				segmentId: trackingSegment.id,
				attemptId: trackingExecutionAttempt.id,
				profileDigest: trackingSegment.profileDigest,
				specificationDigest: trackingSegment.specificationDigest,
				leaseId: trackingExecutionAttempt.leaseId,
				fence: trackingExecutionAttempt.fence,
				acceptedObjectKey: sql<string>`${command.acceptedObjectKey}`,
				checksumSha256: sql<string>`${command.checksumSha256}`,
				contractDigest: sql<string>`${command.contractDigest}`,
				byteCount: sql<number>`${command.byteCount}`,
				outcome: sql<'completed' | 'tracking-gap'>`${command.outcome}`,
				gapJson: sql<string | null>`${gapJson}`,
				firstTimestampMs: sql<number | null>`${command.firstTimestampMs}`,
				lastTimestampMs: sql<number | null>`${command.lastTimestampMs}`,
				createdAt: sql<string>`${command.createdAt}`,
			})
			.from(trackingSegment)
			.innerJoin(
				trackingExecutionAttempt,
				eq(trackingExecutionAttempt.id, trackingSegment.currentAttemptId),
			)
			.innerJoin(
				trackingArtifactPromotion,
				eq(trackingArtifactPromotion.artifactId, command.artifactId),
			)
			.innerJoin(
				trackingTransferRequest,
				eq(trackingTransferRequest.id, command.transferRequestId),
			)
			.innerJoin(trackingRun, eq(trackingRun.id, trackingSegment.runId))
			.where(
				and(
					eq(trackingRun.id, command.runId),
					eq(trackingRun.ownerId, command.ownerId),
					eq(trackingRun.status, 'active'),
					eq(trackingSegment.id, command.segmentId),
					isNull(trackingSegment.outcome),
					isNull(trackingSegment.acceptedArtifactId),
					eq(trackingSegment.currentAttemptId, command.attemptId),
					eq(trackingSegment.authorityLeaseId, command.leaseId),
					eq(trackingSegment.authorityFence, command.fence),
					eq(trackingExecutionAttempt.id, command.attemptId),
					eq(trackingExecutionAttempt.leaseId, command.leaseId),
					eq(trackingExecutionAttempt.fence, command.fence),
					eq(trackingExecutionAttempt.state, 'output-ready'),
					eq(trackingSegment.profileDigest, command.profileDigest),
					eq(trackingSegment.specificationDigest, command.specificationDigest),
					eq(trackingExecutionAttempt.profileDigest, command.profileDigest),
					eq(
						trackingExecutionAttempt.specificationDigest,
						command.specificationDigest,
					),
					eq(trackingArtifactPromotion.runId, command.runId),
					eq(trackingArtifactPromotion.segmentId, command.segmentId),
					eq(trackingArtifactPromotion.attemptId, command.attemptId),
					eq(
						trackingArtifactPromotion.transferRequestId,
						command.transferRequestId,
					),
					eq(trackingArtifactPromotion.state, 'promoted'),
					eq(
						trackingArtifactPromotion.acceptedObjectKey,
						command.acceptedObjectKey,
					),
					eq(trackingArtifactPromotion.checksumSha256, command.checksumSha256),
					eq(trackingArtifactPromotion.contractDigest, command.contractDigest),
					eq(trackingArtifactPromotion.byteCount, command.byteCount),
					eq(trackingTransferRequest.attemptId, command.attemptId),
					eq(trackingTransferRequest.role, 'observation-artifact'),
					eq(trackingTransferRequest.method, 'PUT'),
					eq(trackingTransferRequest.state, 'granted'),
				),
			);
		await this.database.batch([
			this.database
				.insert(subjectObservationArtifact)
				.select(artifactSelection)
				.onConflictDoNothing(),
			this.database
				.update(trackingSegment)
				.set({
					outcome: command.outcome,
					gapJson,
					acceptedArtifactId: command.artifactId,
					currentAttemptId: null,
					authorityLeaseId: null,
					authorityFence: null,
					version: segment.version + 1,
				})
				.where(
					and(
						eq(trackingSegment.id, command.segmentId),
						eq(trackingSegment.version, segment.version),
						eq(trackingSegment.currentAttemptId, command.attemptId),
						eq(trackingSegment.authorityLeaseId, command.leaseId),
						eq(trackingSegment.authorityFence, command.fence),
						isNull(trackingSegment.acceptedArtifactId),
						exists(
							this.database
								.select({ id: subjectObservationArtifact.id })
								.from(subjectObservationArtifact)
								.where(
									and(
										eq(subjectObservationArtifact.id, command.artifactId),
										eq(subjectObservationArtifact.segmentId, command.segmentId),
									),
								),
						),
					),
				),
			this.database
				.update(trackingExecutionAttempt)
				.set({
					state: 'completed',
					version: attempt.version + 1,
					updatedAt: command.createdAt,
				})
				.where(
					and(
						eq(trackingExecutionAttempt.id, command.attemptId),
						eq(trackingExecutionAttempt.state, 'output-ready'),
						eq(trackingExecutionAttempt.version, attempt.version),
						exists(
							this.database
								.select({ id: trackingSegment.id })
								.from(trackingSegment)
								.where(
									and(
										eq(trackingSegment.id, command.segmentId),
										eq(trackingSegment.acceptedArtifactId, command.artifactId),
									),
								),
						),
					),
				),
			this.database
				.update(trackingArtifactPromotion)
				.set({
					state: 'accepted',
					version: sql`${trackingArtifactPromotion.version} + 1`,
					updatedAt: command.createdAt,
				})
				.where(
					and(
						eq(trackingArtifactPromotion.artifactId, command.artifactId),
						eq(trackingArtifactPromotion.state, 'promoted'),
						exists(
							this.database
								.select({ id: subjectObservationArtifact.id })
								.from(subjectObservationArtifact)
								.where(eq(subjectObservationArtifact.id, command.artifactId)),
						),
					),
				),
			this.database
				.update(trackingTransferRequest)
				.set({
					state: 'completed',
					version: sql`${trackingTransferRequest.version} + 1`,
					updatedAt: command.createdAt,
				})
				.where(
					and(
						eq(trackingTransferRequest.id, command.transferRequestId),
						eq(trackingTransferRequest.attemptId, command.attemptId),
						eq(trackingTransferRequest.state, 'granted'),
						exists(
							this.database
								.select({ id: subjectObservationArtifact.id })
								.from(subjectObservationArtifact)
								.where(eq(subjectObservationArtifact.id, command.artifactId)),
						),
					),
				),
		]);
		const [accepted, updatedSegment, promotion] = await Promise.all([
			this.acceptedArtifact(command.artifactId),
			this.ownedSegment(command.runId, command.segmentId),
			this.database
				.select()
				.from(trackingArtifactPromotion)
				.where(eq(trackingArtifactPromotion.artifactId, command.artifactId))
				.get(),
		]);
		/* c8 ignore next 3 -- these are post-batch D1 race defenses; acceptance itself is one conditional batch. */
		if (
			!accepted ||
			updatedSegment?.acceptedArtifactId !== command.artifactId ||
			promotion?.state !== 'accepted'
		)
			throw stale('Tracking artifact lost its acceptance race');
		/* c8 ignore next 2 -- a committed immutable artifact cannot change between the conditional batch and this read. */
		if (!artifactMatches(accepted, command))
			throw conflict('Accepted artifact identity is inconsistent');
		return accepted;
	}

	async fenceRun(
		commandValue: FenceTrackingRunCommand,
	): Promise<TrackingRunRecord> {
		const command = fenceTrackingRunCommandSchema.parse(commandValue);
		const run = await this.requireOwnedRun(command.ownerId, command.runId);
		if (
			run.status === command.status &&
			run.version === command.expectedVersion + 1 &&
			run.completedAt === command.completedAt
		)
			return run;
		if (run.status !== 'active' || run.version !== command.expectedVersion)
			throw stale('Tracking run has already changed');
		const updated = await this.database
			.update(trackingRun)
			.set({
				status: command.status,
				version: run.version + 1,
				completedAt: command.completedAt,
			})
			.where(
				and(
					eq(trackingRun.id, command.runId),
					eq(trackingRun.ownerId, command.ownerId),
					eq(trackingRun.status, 'active'),
					eq(trackingRun.version, command.expectedVersion),
				),
			)
			.returning()
			.get();
		/* c8 ignore next -- a zero-row result requires a concurrent D1 witness change after the read above. */
		if (!updated) throw stale('Tracking run fencing witness is stale');
		return updated;
	}

	async publicProvenance(
		ownerId: string,
		analysisId: string,
		runId: string,
	): Promise<PublicTrackingProvenance> {
		const rows = await this.database
			.select()
			.from(trackingPublicProvenance)
			.where(
				and(
					eq(trackingPublicProvenance.ownerId, ownerId),
					eq(trackingPublicProvenance.analysisId, analysisId),
					eq(trackingPublicProvenance.runId, runId),
				),
			)
			.orderBy(asc(trackingPublicProvenance.segmentOrder));
		const first = rows[0];
		if (!first?.runId || !first.profileDigest)
			throw notFound('Tracking provenance was not found');
		return publicTrackingProvenanceSchema.parse({
			runId: first.runId,
			profileDigest: first.profileDigest,
			segments: rows.flatMap((row) => {
				if (row.segmentId === null || row.segmentOrder === null) return [];
				return [
					{
						segmentId: row.segmentId,
						order: row.segmentOrder,
						outcome: row.outcome,
						gap:
							row.gapJson === null
								? null
								: trackingGapSchema.parse(JSON.parse(row.gapJson)),
						artifact:
							row.artifactId === null
								? null
								: {
										artifactId: row.artifactId,
										digest: row.artifactDigest,
										contractDigest: row.contractDigest,
										byteCount: row.byteCount,
									},
					},
				];
			}),
		});
	}

	async publicState(
		ownerId: string,
		analysisId: string,
		runId: string,
	): Promise<PublicTrackingState> {
		const run = await this.requireOwnedRun(ownerId, runId);
		if (run.analysisId !== analysisId)
			throw notFound('Tracking run was not found');
		const [segments, attempts] = await Promise.all([
			this.database
				.select()
				.from(trackingSegment)
				.where(eq(trackingSegment.runId, runId))
				.orderBy(asc(trackingSegment.order)),
			this.database
				.select({
					id: trackingExecutionAttempt.id,
					state: trackingExecutionAttempt.state,
					progress: trackingExecutionAttempt.progress,
					safeFailureCode: trackingExecutionAttempt.safeFailureCode,
					createdAt: trackingExecutionAttempt.createdAt,
				})
				.from(trackingExecutionAttempt)
				.innerJoin(
					trackingSegment,
					eq(trackingSegment.id, trackingExecutionAttempt.segmentId),
				)
				.where(eq(trackingSegment.runId, runId))
				.orderBy(
					asc(trackingExecutionAttempt.createdAt),
					asc(trackingExecutionAttempt.id),
				),
		]);
		const attemptSummaries = attempts as TrackingAttemptSummary[];
		const currentAttemptIds = new Set(
			segments.flatMap((segment) =>
				segment.currentAttemptId === null ? [] : [segment.currentAttemptId],
			),
		);
		const latestAttempt =
			attemptSummaries.find((attempt) => currentAttemptIds.has(attempt.id)) ??
			attemptSummaries.at(-1);
		const highWater = attemptSummaries.reduce(
			(progress, attempt) => Math.max(progress, attempt.progress),
			0,
		);
		const acceptedGap = segments.some(
			(segment) => segment.outcome === 'tracking-gap',
		);
		const hasAcceptedEvidence = segments.some(
			(segment) => segment.acceptedArtifactId !== null,
		);
		let state: Omit<PublicTrackingState, 'runId' | 'stage'>;
		/* c8 ignore next 7 -- final run completion belongs to the later measurement/finalization slice; this projection is reserved for that D1 transition. */
		if (run.status === 'completed') {
			state = {
				lifecycle: 'completed',
				progress: 100,
				waitReason: null,
				safeFailureCode: null,
			};
		} else if (run.status === 'cancelled' || run.status === 'replaced') {
			state = {
				lifecycle: 'cancelled',
				progress: Math.min(highWater, 99),
				waitReason: null,
				safeFailureCode: null,
			};
		} else if (run.status === 'failed' || latestAttempt?.state === 'failed') {
			state = {
				lifecycle: 'failed',
				progress: Math.min(highWater, 99),
				waitReason: null,
				safeFailureCode: publicFailureCode(latestAttempt?.safeFailureCode),
			};
		} else if (acceptedGap) {
			state = {
				lifecycle: 'awaiting-reidentification',
				progress: 99,
				waitReason: null,
				safeFailureCode: null,
			};
		} else if (hasAcceptedEvidence) {
			state = {
				lifecycle: 'running',
				progress: 99,
				waitReason: null,
				safeFailureCode: null,
			};
		} else if (latestAttempt) {
			state = {
				lifecycle: 'running',
				progress: Math.min(highWater, 99),
				waitReason: null,
				safeFailureCode: null,
			};
		} else {
			state = {
				lifecycle: 'queued',
				progress: 0,
				waitReason:
					segments.length === 0
						? 'waiting-for-provider'
						: 'waiting-for-capacity',
				safeFailureCode: null,
			};
		}
		return publicTrackingStateSchema.parse({
			runId,
			stage: 'tracking',
			...state,
		});
	}

	private async requireOwnedRun(
		ownerId: string,
		runId: string,
	): Promise<TrackingRunRecord> {
		const run = await this.database
			.select()
			.from(trackingRun)
			.where(and(eq(trackingRun.id, runId), eq(trackingRun.ownerId, ownerId)))
			.get();
		if (!run) throw notFound('Tracking run was not found');
		return run;
	}

	private async requireActiveRun(
		ownerId: string,
		runId: string,
	): Promise<TrackingRunRecord> {
		const run = await this.requireOwnedRun(ownerId, runId);
		if (run.status !== 'active')
			throw stale('Tracking run is no longer active');
		return run;
	}

	private async ownedSegment(
		runId: string,
		segmentId: string,
	): Promise<TrackingSegmentRecord | undefined> {
		return this.database
			.select()
			.from(trackingSegment)
			.where(
				and(
					eq(trackingSegment.id, segmentId),
					eq(trackingSegment.runId, runId),
				),
			)
			.get();
	}

	private async preparedTransferObject(
		segment: TrackingSegmentRecord,
		role: 'prepared-media' | 'frame-manifest',
	): Promise<{
		objectScope: string;
		objectKey: string;
		contentType: string;
	}> {
		const object = await this.database
			.select({
				objectKey: preparedTrackingObject.objectKey,
				contentType: preparedTrackingObject.contentType,
			})
			.from(preparedTrackingObject)
			.where(
				and(
					eq(preparedTrackingObject.preparedMediaId, segment.preparedMediaId),
					eq(preparedTrackingObject.runId, segment.runId),
					eq(preparedTrackingObject.role, role),
				),
			)
			.get();
		/* c8 ignore next -- accepted prepared authority requires both immutable role objects. */
		if (!object) throw notFound('Prepared Tracking object was not found');
		return {
			objectScope: segment.preparedMediaId,
			objectKey: object.objectKey,
			contentType: object.contentType,
		};
	}

	private async requireCurrentAttempt(command: {
		ownerId: string;
		runId: string;
		segmentId: string;
		attemptId: string;
		leaseId: string;
		fence: number;
	}): Promise<TrackingAttemptRecord> {
		await this.requireActiveRun(command.ownerId, command.runId);
		const [segment, attempt] = await Promise.all([
			this.ownedSegment(command.runId, command.segmentId),
			this.database
				.select()
				.from(trackingExecutionAttempt)
				.where(eq(trackingExecutionAttempt.id, command.attemptId))
				.get(),
		]);
		if (!segment || !attempt) throw notFound('Tracking attempt was not found');
		this.assertAttemptIdentity(attempt, segment, command);
		if (
			segment.currentAttemptId !== command.attemptId ||
			segment.authorityLeaseId !== command.leaseId ||
			segment.authorityFence !== command.fence ||
			!MUTABLE_ATTEMPT_STATES.includes(
				attempt.state as (typeof MUTABLE_ATTEMPT_STATES)[number],
			)
		)
			throw stale('Tracking attempt does not hold current authority');
		return attempt;
	}

	private assertAttemptIdentity(
		attempt: TrackingAttemptRecord,
		segment: TrackingSegmentRecord,
		command: { segmentId: string; leaseId: string; fence: number },
	): void {
		if (
			attempt.segmentId !== command.segmentId ||
			attempt.leaseId !== command.leaseId ||
			attempt.fence !== command.fence ||
			attempt.profileDigest !== segment.profileDigest ||
			attempt.specificationDigest !== segment.specificationDigest
		)
			throw conflict('Tracking-attempt identity is inconsistent');
	}

	private currentAuthorityExists(command: {
		ownerId: string;
		runId: string;
		segmentId: string;
		attemptId: string;
		leaseId: string;
		fence: number;
	}) {
		return exists(
			this.database
				.select({ id: trackingSegment.id })
				.from(trackingSegment)
				.innerJoin(trackingRun, eq(trackingRun.id, trackingSegment.runId))
				.where(
					and(
						eq(trackingRun.id, command.runId),
						eq(trackingRun.ownerId, command.ownerId),
						eq(trackingRun.status, 'active'),
						eq(trackingSegment.id, command.segmentId),
						eq(trackingSegment.currentAttemptId, command.attemptId),
						eq(trackingSegment.authorityLeaseId, command.leaseId),
						eq(trackingSegment.authorityFence, command.fence),
					),
				),
		);
	}

	private async acceptedArtifact(
		artifactId: string,
	): Promise<SubjectObservationArtifactRecord | undefined> {
		return this.database
			.select()
			.from(subjectObservationArtifact)
			.where(eq(subjectObservationArtifact.id, artifactId))
			.get();
	}
}

const artifactMatches = (
	artifact: SubjectObservationArtifactRecord,
	command: AcceptTrackingArtifactCommand,
): boolean =>
	artifact.id === command.artifactId &&
	artifact.runId === command.runId &&
	artifact.segmentId === command.segmentId &&
	artifact.attemptId === command.attemptId &&
	artifact.leaseId === command.leaseId &&
	artifact.fence === command.fence &&
	artifact.profileDigest === command.profileDigest &&
	artifact.specificationDigest === command.specificationDigest &&
	artifact.acceptedObjectKey === command.acceptedObjectKey &&
	artifact.checksumSha256 === command.checksumSha256 &&
	artifact.contractDigest === command.contractDigest &&
	artifact.byteCount === command.byteCount &&
	artifact.outcome === command.outcome &&
	artifact.gapJson ===
		(command.gap === null ? null : JSON.stringify(command.gap)) &&
	artifact.firstTimestampMs === command.firstTimestampMs &&
	artifact.lastTimestampMs === command.lastTimestampMs &&
	artifact.createdAt === command.createdAt;

const promotionMatches = (
	promotion: TrackingArtifactPromotionRecord,
	command: RecordTrackingArtifactPromotionCommand,
): boolean =>
	promotion.artifactId === command.artifactId &&
	promotion.runId === command.runId &&
	promotion.segmentId === command.segmentId &&
	promotion.attemptId === command.attemptId &&
	promotion.transferRequestId === command.transferRequestId &&
	promotion.stagingObjectKey === command.stagingObjectKey &&
	promotion.acceptedObjectKey === command.acceptedObjectKey &&
	promotion.checksumSha256 === command.checksumSha256 &&
	promotion.contractDigest === command.contractDigest &&
	promotion.byteCount === command.byteCount;

const isAllowedAttemptTransition = (current: string, next: string): boolean =>
	MUTABLE_ATTEMPT_STATES.includes(
		current as (typeof MUTABLE_ATTEMPT_STATES)[number],
	) &&
	ALLOWED_ATTEMPT_TRANSITIONS[
		current as (typeof MUTABLE_ATTEMPT_STATES)[number]
	].includes(next);

const publicFailureCode = (
	value: string | null | undefined,
): PublicTrackingState['safeFailureCode'] => {
	if (
		value === 'TRACKING_PROVIDER_UNAVAILABLE' ||
		value === 'TRACKING_PROVIDER_FAILED' ||
		value === 'TRACKING_ARTIFACT_INVALID'
	)
		return value;
	return 'TRACKING_PROVIDER_FAILED';
};

const notFound = (message: string): TrackingAuthorityError =>
	new TrackingAuthorityError('NOT_FOUND', message);

const conflict = (message: string): TrackingAuthorityError =>
	new TrackingAuthorityError('CONFLICT', message);

const stale = (message: string): TrackingAuthorityError =>
	new TrackingAuthorityError('STALE_AUTHORITY', message);

const invalidTransition = (message: string): TrackingAuthorityError =>
	new TrackingAuthorityError('INVALID_TRANSITION', message);
