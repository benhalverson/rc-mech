import { and, asc, eq, exists, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
	type AcceptTrackingArtifactCommand,
	type ActivateTrackingAttemptCommand,
	acceptTrackingArtifactCommandSchema,
	activateTrackingAttemptCommandSchema,
	type CreateTrackingRunCommand,
	type CreateTrackingSegmentCommand,
	createTrackingRunCommandSchema,
	createTrackingSegmentCommandSchema,
	type FenceTrackingRunCommand,
	fenceTrackingRunCommandSchema,
	type PublicTrackingProvenance,
	publicTrackingProvenanceSchema,
	type RecordTrackingTransferRequestCommand,
	recordTrackingTransferRequestCommandSchema,
	type TransitionTrackingAttemptCommand,
	type TransitionTrackingTransferRequestCommand,
	trackingGapSchema,
	transitionTrackingAttemptCommandSchema,
	transitionTrackingTransferRequestCommandSchema,
} from './authority-contracts';
import {
	inferenceProfileAuthority,
	preparedTrackingMedia,
	preparedTrackingObject,
	preparedTrackingRetention,
	subjectObservationArtifact,
	trackingAuthoritySchema,
	trackingExecutionAttempt,
	trackingPublicProvenance,
	trackingRun,
	trackingRunInput,
	trackingSegment,
	trackingTransferRequest,
} from './authority-schema';
import { preparedMediaArtifactSchema } from './contracts';
import {
	digestInferenceProfile,
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
type TrackingTransferRequestRecord =
	typeof trackingTransferRequest.$inferSelect;
type SubjectObservationArtifactRecord =
	typeof subjectObservationArtifact.$inferSelect;

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
			!isAllowedAttemptTransition(command.expectedState, command.nextState) ||
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
			stored.objectScope !== command.objectScope ||
			stored.createdAt !== command.createdAt
		)
			throw conflict(
				'Transfer-request identity was replayed with different immutable scope',
			);
		return stored;
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

	async acceptArtifact(
		commandValue: AcceptTrackingArtifactCommand,
	): Promise<SubjectObservationArtifactRecord> {
		const command = acceptTrackingArtifactCommandSchema.parse(commandValue);
		await this.requireActiveRun(command.ownerId, command.runId);
		const segment = await this.ownedSegment(command.runId, command.segmentId);
		if (!segment) throw notFound('Tracking segment was not found');
		if (segment.acceptedArtifactId !== null) {
			const accepted = await this.acceptedArtifact(segment.acceptedArtifactId);
			if (accepted && artifactMatches(accepted, command)) return accepted;
			throw conflict(
				'Tracking segment already has different accepted evidence',
			);
		}
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
					eq(
						trackingExecutionAttempt.profileDigest,
						trackingSegment.profileDigest,
					),
					eq(
						trackingExecutionAttempt.specificationDigest,
						trackingSegment.specificationDigest,
					),
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
		]);
		const [accepted, updatedSegment] = await Promise.all([
			this.acceptedArtifact(command.artifactId),
			this.ownedSegment(command.runId, command.segmentId),
		]);
		/* c8 ignore next 3 -- these are post-batch D1 race defenses; acceptance itself is one conditional batch. */
		if (!accepted || updatedSegment?.acceptedArtifactId !== command.artifactId)
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

const isAllowedAttemptTransition = (current: string, next: string): boolean =>
	MUTABLE_ATTEMPT_STATES.includes(
		current as (typeof MUTABLE_ATTEMPT_STATES)[number],
	) &&
	ALLOWED_ATTEMPT_TRANSITIONS[
		current as (typeof MUTABLE_ATTEMPT_STATES)[number]
	].includes(next);

const notFound = (message: string): TrackingAuthorityError =>
	new TrackingAuthorityError('NOT_FOUND', message);

const conflict = (message: string): TrackingAuthorityError =>
	new TrackingAuthorityError('CONFLICT', message);

const stale = (message: string): TrackingAuthorityError =>
	new TrackingAuthorityError('STALE_AUTHORITY', message);

const invalidTransition = (message: string): TrackingAuthorityError =>
	new TrackingAuthorityError('INVALID_TRANSITION', message);
