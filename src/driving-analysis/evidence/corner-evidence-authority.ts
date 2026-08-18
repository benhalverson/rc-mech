import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { drivingAnalysis, trackCorner, trackMapVersion } from '../../schema';
import {
	inferenceProfileAuthority,
	preparedTrackingMedia,
	preparedTrackingObject,
	subjectObservationArtifact,
	trackingExecutionAttempt,
	trackingRun,
	trackingRunInput,
	trackingSegment,
} from '../tracking/authority-schema';
import {
	preparedMediaArtifactSchema,
	subjectSeedSchema,
} from '../tracking/contracts';
import { inferenceProfileSchema } from '../tracking/inference-profile';
import { FRAME_MANIFEST_CONTENT_TYPE } from '../tracking/track-view-contracts';
import type {
	AcceptedCornerEvidenceContext,
	AcceptedCornerEvidenceIdentity,
	CommitCornerEvidenceCommand,
	CornerEvidenceAuthorityPort,
	CornerEvidenceCommitResult,
} from './accepted-corner-evidence';
import type {
	CornerEvidenceMeasurement,
	CornerPassEvidence,
	EvidenceCorner,
} from './corner-evidence';
import { cornerEvidenceBatch, cornerPassEvidence } from './evidence-schema';

const MAX_PERSISTED_PASSES = 10_000;
const PASS_INSERT_CHUNK_SIZE = 100;

export class CornerEvidenceAuthorityError extends Error {
	constructor(readonly code: 'STALE_AUTHORITY' | 'RETRYABLE_INFRASTRUCTURE') {
		super(code);
		this.name = 'CornerEvidenceAuthorityError';
	}
}

export class CornerEvidenceAuthority implements CornerEvidenceAuthorityPort {
	private readonly database;

	constructor(binding: D1Database) {
		this.database = drizzle(binding);
	}

	async load(
		identity: AcceptedCornerEvidenceIdentity,
	): Promise<AcceptedCornerEvidenceContext> {
		const source = await this.database
			.select({
				ownerId: trackingRun.ownerId,
				analysisId: trackingRun.analysisId,
				runId: sql<string>`${trackingRun.id}`.as('evidence_run_id'),
				workflowId: trackingRun.workflowId,
				segmentId: sql<string>`${trackingSegment.id}`.as('evidence_segment_id'),
				artifactId: sql<string>`${subjectObservationArtifact.id}`.as(
					'evidence_artifact_id',
				),
				attemptId: subjectObservationArtifact.attemptId,
				profileDigest: subjectObservationArtifact.profileDigest,
				specificationDigest: subjectObservationArtifact.specificationDigest,
				acceptedObjectKey: subjectObservationArtifact.acceptedObjectKey,
				observationChecksumSha256:
					sql<string>`${subjectObservationArtifact.checksumSha256}`.as(
						'evidence_observation_checksum',
					),
				observationContractDigest: subjectObservationArtifact.contractDigest,
				observationByteCount:
					sql<number>`${subjectObservationArtifact.byteCount}`.as(
						'evidence_observation_byte_count',
					),
				outcome: subjectObservationArtifact.outcome,
				gapJson: subjectObservationArtifact.gapJson,
				firstTimestampMs: subjectObservationArtifact.firstTimestampMs,
				lastTimestampMs: subjectObservationArtifact.lastTimestampMs,
				artifactCreatedAt: subjectObservationArtifact.createdAt,
				preparedMediaId: sql<string>`${preparedTrackingMedia.id}`.as(
					'evidence_prepared_media_id',
				),
				preparedDescriptorJson: preparedTrackingMedia.descriptorJson,
				seedJson: trackingSegment.seedJson,
				profileJson: inferenceProfileAuthority.configurationJson,
				manifestObjectKey: preparedTrackingObject.objectKey,
				manifestByteCount: sql<number>`${preparedTrackingObject.byteCount}`.as(
					'evidence_manifest_byte_count',
				),
				manifestChecksumSha256:
					sql<string>`${preparedTrackingObject.checksumSha256}`.as(
						'evidence_manifest_checksum',
					),
				approvedTrackMapVersionId: trackingRunInput.approvedTrackMapVersionId,
			})
			.from(trackingRun)
			.innerJoin(trackingRunInput, eq(trackingRunInput.runId, trackingRun.id))
			.innerJoin(
				trackingSegment,
				and(
					eq(trackingSegment.runId, trackingRun.id),
					eq(trackingSegment.id, identity.segmentId),
				),
			)
			.innerJoin(
				subjectObservationArtifact,
				eq(subjectObservationArtifact.id, trackingSegment.acceptedArtifactId),
			)
			.innerJoin(
				trackingExecutionAttempt,
				eq(trackingExecutionAttempt.id, subjectObservationArtifact.attemptId),
			)
			.innerJoin(
				preparedTrackingMedia,
				and(
					eq(preparedTrackingMedia.id, trackingSegment.preparedMediaId),
					eq(preparedTrackingMedia.runId, trackingRun.id),
				),
			)
			.innerJoin(
				preparedTrackingObject,
				and(
					eq(preparedTrackingObject.preparedMediaId, preparedTrackingMedia.id),
					eq(preparedTrackingObject.runId, trackingRun.id),
					eq(preparedTrackingObject.role, 'frame-manifest'),
					eq(preparedTrackingObject.contentType, FRAME_MANIFEST_CONTENT_TYPE),
					eq(preparedTrackingObject.contentEncoding, 'gzip'),
				),
			)
			.innerJoin(
				inferenceProfileAuthority,
				eq(
					inferenceProfileAuthority.profileDigest,
					trackingSegment.profileDigest,
				),
			)
			.innerJoin(
				drivingAnalysis,
				and(
					eq(drivingAnalysis.id, trackingRun.analysisId),
					eq(drivingAnalysis.ownerId, trackingRun.ownerId),
					eq(drivingAnalysis.workflowId, trackingRun.workflowId),
				),
			)
			.innerJoin(
				trackMapVersion,
				and(
					eq(trackMapVersion.id, trackingRunInput.approvedTrackMapVersionId),
					eq(
						drivingAnalysis.approvedTrackMapVersionId,
						trackingRunInput.approvedTrackMapVersionId,
					),
				),
			)
			.where(
				and(
					eq(trackingRun.id, identity.runId),
					eq(trackingRun.ownerId, identity.ownerId),
					eq(trackingRun.analysisId, identity.analysisId),
					eq(trackingRun.workflowId, identity.workflowId),
					eq(trackingRun.status, 'active'),
					eq(trackingRunInput.ownerId, identity.ownerId),
					eq(trackingRun.inputDigest, trackingRunInput.inputDigest),
					eq(trackingSegment.id, identity.segmentId),
					isNotNull(trackingSegment.outcome),
					isNotNull(trackingSegment.acceptedArtifactId),
					eq(trackingSegment.outcome, subjectObservationArtifact.outcome),
					eq(subjectObservationArtifact.runId, trackingRun.id),
					eq(subjectObservationArtifact.segmentId, trackingSegment.id),
					or(
						and(
							isNull(trackingSegment.gapJson),
							isNull(subjectObservationArtifact.gapJson),
						),
						eq(trackingSegment.gapJson, subjectObservationArtifact.gapJson),
					),
					eq(trackingExecutionAttempt.segmentId, trackingSegment.id),
					eq(trackingExecutionAttempt.state, 'completed'),
					eq(
						trackingExecutionAttempt.profileDigest,
						subjectObservationArtifact.profileDigest,
					),
					eq(
						trackingExecutionAttempt.specificationDigest,
						subjectObservationArtifact.specificationDigest,
					),
					eq(
						trackingSegment.profileDigest,
						subjectObservationArtifact.profileDigest,
					),
					eq(
						trackingSegment.specificationDigest,
						subjectObservationArtifact.specificationDigest,
					),
					eq(
						preparedTrackingMedia.preparationInputDigest,
						trackingRunInput.inputDigest,
					),
					eq(
						preparedTrackingMedia.sourceChecksum,
						trackingRunInput.sourceChecksum,
					),
					eq(
						preparedTrackingMedia.windowStartTimestampMs,
						trackingRunInput.windowStartTimestampMs,
					),
					eq(
						preparedTrackingMedia.windowEndTimestampMs,
						trackingRunInput.windowEndTimestampMs,
					),
					eq(drivingAnalysis.stage, 'tracking'),
					inArray(drivingAnalysis.status, [
						'running',
						'awaiting-reidentification',
					]),
					eq(trackMapVersion.status, 'approved'),
					eq(
						drivingAnalysis.raceWindowStartMs,
						trackingRunInput.windowStartTimestampMs,
					),
					eq(
						drivingAnalysis.raceWindowEndMs,
						trackingRunInput.windowEndTimestampMs,
					),
				),
			)
			.get();
		if (!source) throw stale();
		const corners = await this.loadCorners(source.approvedTrackMapVersionId);
		const existing = await this.loadExisting(source.artifactId);
		if (existing && !batchMatchesSource(existing.batch, source)) throw stale();
		return {
			ownerId: source.ownerId,
			analysisId: source.analysisId,
			runId: source.runId,
			workflowId: source.workflowId,
			segmentId: source.segmentId,
			artifact: {
				id: source.artifactId,
				attemptId: source.attemptId,
				profileDigest: source.profileDigest,
				specificationDigest: source.specificationDigest,
				acceptedObjectKey: source.acceptedObjectKey,
				checksumSha256: source.observationChecksumSha256,
				contractDigest: source.observationContractDigest,
				byteCount: source.observationByteCount,
				outcome: source.outcome,
				gapJson: source.gapJson,
				firstTimestampMs: source.firstTimestampMs,
				lastTimestampMs: source.lastTimestampMs,
				createdAt: source.artifactCreatedAt,
			},
			prepared: preparedMediaArtifactSchema.parse(
				JSON.parse(source.preparedDescriptorJson),
			),
			seed: subjectSeedSchema.parse(JSON.parse(source.seedJson)),
			profile: inferenceProfileSchema.parse(JSON.parse(source.profileJson)),
			manifestObject: {
				objectKey: source.manifestObjectKey,
				byteCount: source.manifestByteCount,
				checksumSha256: source.manifestChecksumSha256,
			},
			approvedTrackMapVersionId: source.approvedTrackMapVersionId,
			corners,
			existingMeasurement: existing?.measurement ?? null,
		};
	}

	async commit(
		command: CommitCornerEvidenceCommand,
	): Promise<CornerEvidenceCommitResult> {
		if (
			command.measurement.version !== 'corner-evidence.v1' ||
			command.measurement.passes.length > MAX_PERSISTED_PASSES
		)
			throw stale();
		const context = await this.load(command);
		assertCommandMatchesContext(command, context);
		assertMeasurementCorners(command.measurement, context.corners);
		const existing = await this.loadExisting(command.artifactId);
		if (existing) {
			assertStoredMatchesCommand(existing, command);
			return { status: 'replayed', measurement: existing.measurement };
		}

		const batchSelection = this.database
			.select({
				artifactId: sql<string>`${command.artifactId}`,
				ownerId: sql<string>`${command.ownerId}`,
				analysisId: sql<string>`${command.analysisId}`,
				runId: sql<string>`${command.runId}`,
				workflowId: sql<string>`${command.workflowId}`,
				segmentId: sql<string>`${command.segmentId}`,
				attemptId: sql<string>`${command.attemptId}`,
				profileDigest: sql<string>`${command.profileDigest}`,
				specificationDigest: sql<string>`${command.specificationDigest}`,
				preparedMediaId: sql<string>`${command.preparedMediaId}`,
				observationObjectKey: sql<string>`${command.observationObjectKey}`,
				observationChecksumSha256: sql<string>`${command.observationChecksumSha256}`,
				observationContractDigest: sql<string>`${command.observationContractDigest}`,
				manifestObjectKey: sql<string>`${command.manifestObjectKey}`,
				manifestChecksumSha256: sql<string>`${command.manifestChecksumSha256}`,
				approvedTrackMapVersionId: sql<string>`${command.approvedTrackMapVersionId}`,
				measurementVersion: sql<'corner-evidence.v1'>`${command.measurement.version}`,
				measurementInputDigest: sql<string>`${command.measurementInputDigest}`,
				measurementDigest: sql<string>`${command.measurementDigest}`,
				createdAt: sql<string>`${command.createdAt}`,
			})
			.from(subjectObservationArtifact)
			.innerJoin(
				trackingSegment,
				and(
					eq(trackingSegment.id, subjectObservationArtifact.segmentId),
					eq(trackingSegment.acceptedArtifactId, subjectObservationArtifact.id),
				),
			)
			.innerJoin(trackingRun, eq(trackingRun.id, trackingSegment.runId))
			.innerJoin(trackingRunInput, eq(trackingRunInput.runId, trackingRun.id))
			.innerJoin(
				preparedTrackingMedia,
				and(
					eq(preparedTrackingMedia.id, command.preparedMediaId),
					eq(preparedTrackingMedia.runId, command.runId),
				),
			)
			.innerJoin(
				preparedTrackingObject,
				and(
					eq(preparedTrackingObject.preparedMediaId, command.preparedMediaId),
					eq(preparedTrackingObject.role, 'frame-manifest'),
					eq(preparedTrackingObject.objectKey, command.manifestObjectKey),
					eq(
						preparedTrackingObject.checksumSha256,
						command.manifestChecksumSha256,
					),
				),
			)
			.innerJoin(
				trackingExecutionAttempt,
				eq(trackingExecutionAttempt.id, command.attemptId),
			)
			.innerJoin(
				drivingAnalysis,
				and(
					eq(drivingAnalysis.id, command.analysisId),
					eq(drivingAnalysis.ownerId, command.ownerId),
					eq(drivingAnalysis.workflowId, command.workflowId),
				),
			)
			.innerJoin(
				trackMapVersion,
				and(
					eq(trackMapVersion.id, command.approvedTrackMapVersionId),
					eq(trackMapVersion.status, 'approved'),
				),
			)
			.where(
				and(
					eq(subjectObservationArtifact.id, command.artifactId),
					eq(subjectObservationArtifact.runId, command.runId),
					eq(subjectObservationArtifact.segmentId, command.segmentId),
					eq(subjectObservationArtifact.attemptId, command.attemptId),
					eq(subjectObservationArtifact.profileDigest, command.profileDigest),
					eq(
						subjectObservationArtifact.specificationDigest,
						command.specificationDigest,
					),
					eq(
						subjectObservationArtifact.acceptedObjectKey,
						command.observationObjectKey,
					),
					eq(
						subjectObservationArtifact.checksumSha256,
						command.observationChecksumSha256,
					),
					eq(
						subjectObservationArtifact.contractDigest,
						command.observationContractDigest,
					),
					eq(subjectObservationArtifact.outcome, trackingSegment.outcome),
					eq(trackingRun.id, command.runId),
					eq(trackingRun.ownerId, command.ownerId),
					eq(trackingRun.analysisId, command.analysisId),
					eq(trackingRun.workflowId, command.workflowId),
					eq(trackingRun.status, 'active'),
					eq(trackingRunInput.ownerId, command.ownerId),
					eq(trackingRun.inputDigest, trackingRunInput.inputDigest),
					eq(
						trackingRunInput.approvedTrackMapVersionId,
						command.approvedTrackMapVersionId,
					),
					eq(trackingExecutionAttempt.state, 'completed'),
					eq(trackingExecutionAttempt.segmentId, command.segmentId),
					eq(trackingExecutionAttempt.profileDigest, command.profileDigest),
					eq(
						trackingExecutionAttempt.specificationDigest,
						command.specificationDigest,
					),
					eq(trackingSegment.preparedMediaId, command.preparedMediaId),
					eq(trackingSegment.profileDigest, command.profileDigest),
					eq(trackingSegment.specificationDigest, command.specificationDigest),
					eq(preparedTrackingObject.runId, command.runId),
					eq(preparedTrackingObject.contentType, FRAME_MANIFEST_CONTENT_TYPE),
					eq(preparedTrackingObject.contentEncoding, 'gzip'),
					eq(drivingAnalysis.stage, 'tracking'),
					inArray(drivingAnalysis.status, [
						'running',
						'awaiting-reidentification',
					]),
					eq(
						drivingAnalysis.approvedTrackMapVersionId,
						command.approvedTrackMapVersionId,
					),
					eq(
						drivingAnalysis.raceWindowStartMs,
						trackingRunInput.windowStartTimestampMs,
					),
					eq(
						drivingAnalysis.raceWindowEndMs,
						trackingRunInput.windowEndTimestampMs,
					),
				),
			);

		const passRows = command.measurement.passes.map((pass) =>
			passValues(command.artifactId, command.measurementDigest, pass),
		);
		const statements = [
			this.database
				.insert(cornerEvidenceBatch)
				.select(batchSelection)
				.onConflictDoNothing(),
			...chunks(passRows, PASS_INSERT_CHUNK_SIZE).map((values) =>
				this.database
					.insert(cornerPassEvidence)
					.values(values)
					.onConflictDoNothing(),
			),
		];
		let batchFailed = false;
		try {
			await this.database.batch(statements);
		} catch {
			batchFailed = true;
		}
		let stored: Awaited<ReturnType<CornerEvidenceAuthority['loadExisting']>>;
		try {
			stored = await this.loadExisting(command.artifactId);
		} catch (error) {
			if (error instanceof CornerEvidenceAuthorityError) throw error;
			throw retryable();
		}
		if (!stored) throw batchFailed ? retryable() : stale();
		assertStoredMatchesCommand(stored, command);
		return { status: 'committed', measurement: stored.measurement };
	}

	private async loadCorners(mapVersionId: string): Promise<EvidenceCorner[]> {
		const records = await this.database
			.select()
			.from(trackCorner)
			.where(eq(trackCorner.mapVersionId, mapVersionId))
			.orderBy(asc(trackCorner.order), asc(trackCorner.id));
		/* c8 ignore next -- approved Track maps require at least one immutable corner. */
		if (records.length === 0) throw stale();
		return records.map((record) => ({
			id: record.id,
			key: record.key,
			order: record.order,
			entryGate: {
				start: { x: record.entryStartX, y: record.entryStartY },
				end: { x: record.entryEndX, y: record.entryEndY },
				direction: record.entryDirection,
			},
			exitGate: {
				start: { x: record.exitStartX, y: record.exitStartY },
				end: { x: record.exitEndX, y: record.exitEndY },
				direction: record.exitDirection,
			},
		}));
	}

	private async loadExisting(artifactId: string): Promise<{
		batch: typeof cornerEvidenceBatch.$inferSelect;
		measurement: CornerEvidenceMeasurement;
	} | null> {
		const batch = await this.database
			.select()
			.from(cornerEvidenceBatch)
			.where(eq(cornerEvidenceBatch.artifactId, artifactId))
			.get();
		if (!batch) return null;
		if (batch.measurementVersion !== 'corner-evidence.v1') throw stale();
		const records = await this.database
			.select()
			.from(cornerPassEvidence)
			.where(eq(cornerPassEvidence.batchArtifactId, artifactId))
			.orderBy(
				asc(cornerPassEvidence.cornerOrder),
				asc(cornerPassEvidence.ordinal),
			);
		return {
			batch,
			measurement: {
				version: 'corner-evidence.v1',
				passes: records.map(recordToPass),
			},
		};
	}
}

const passValues = (
	batchArtifactId: string,
	batchMeasurementDigest: string,
	pass: CornerPassEvidence,
) => ({
	batchArtifactId,
	batchMeasurementDigest,
	cornerId: pass.cornerId,
	cornerKey: pass.cornerKey,
	cornerOrder: pass.cornerOrder,
	ordinal: pass.ordinal,
	entryTimestampMs: pass.entry?.timestampMs ?? null,
	entryBeforeFrameIndex: pass.entry?.beforeFrameIndex ?? null,
	entryAfterFrameIndex: pass.entry?.afterFrameIndex ?? null,
	exitTimestampMs: pass.exit?.timestampMs ?? null,
	exitBeforeFrameIndex: pass.exit?.beforeFrameIndex ?? null,
	exitAfterFrameIndex: pass.exit?.afterFrameIndex ?? null,
	durationMs: pass.durationMs,
	eligibility: pass.eligibility,
	exclusionReason: pass.exclusionReason,
	rank: pass.rank,
	tieGroup: pass.tieGroup,
	best: pass.best,
});

const recordToPass = (
	record: typeof cornerPassEvidence.$inferSelect,
): CornerPassEvidence => {
	const entry = crossingFromRecord(
		record.entryTimestampMs,
		record.entryBeforeFrameIndex,
		record.entryAfterFrameIndex,
	);
	const exit = crossingFromRecord(
		record.exitTimestampMs,
		record.exitBeforeFrameIndex,
		record.exitAfterFrameIndex,
	);
	return {
		cornerId: record.cornerId,
		cornerKey: record.cornerKey,
		cornerOrder: record.cornerOrder,
		ordinal: record.ordinal,
		entry,
		exit,
		durationMs: record.durationMs,
		eligibility: record.eligibility,
		exclusionReason: record.exclusionReason,
		rank: record.rank,
		tieGroup: record.tieGroup,
		best: record.best,
	};
};

const crossingFromRecord = (
	timestampMs: number | null,
	beforeFrameIndex: number | null,
	afterFrameIndex: number | null,
) => {
	if (
		timestampMs === null &&
		beforeFrameIndex === null &&
		afterFrameIndex === null
	)
		return null;
	/* c8 ignore next 6 -- the D1 crossing completeness checks reject partial triples. */
	if (
		timestampMs === null ||
		beforeFrameIndex === null ||
		afterFrameIndex === null
	)
		throw stale();
	return { timestampMs, beforeFrameIndex, afterFrameIndex };
};

const assertCommandMatchesContext = (
	command: CommitCornerEvidenceCommand,
	context: AcceptedCornerEvidenceContext,
): void => {
	if (
		command.artifactId !== context.artifact.id ||
		command.attemptId !== context.artifact.attemptId ||
		command.profileDigest !== context.artifact.profileDigest ||
		command.specificationDigest !== context.artifact.specificationDigest ||
		command.preparedMediaId !== context.prepared.preparedMediaId ||
		command.observationObjectKey !== context.artifact.acceptedObjectKey ||
		command.observationChecksumSha256 !== context.artifact.checksumSha256 ||
		command.observationContractDigest !== context.artifact.contractDigest ||
		command.manifestObjectKey !== context.manifestObject.objectKey ||
		command.manifestChecksumSha256 !== context.manifestObject.checksumSha256 ||
		command.approvedTrackMapVersionId !== context.approvedTrackMapVersionId ||
		!/^[0-9a-f]{64}$/.test(command.measurementInputDigest) ||
		!/^[0-9a-f]{64}$/.test(command.measurementDigest) ||
		Number.isNaN(new Date(command.createdAt).getTime())
	)
		throw stale();
};

const assertMeasurementCorners = (
	measurement: CornerEvidenceMeasurement,
	corners: readonly EvidenceCorner[],
): void => {
	const expected = new Map(corners.map((corner) => [corner.id, corner]));
	if (
		measurement.passes.some((pass) => {
			const corner = expected.get(pass.cornerId);
			return (
				!corner ||
				corner.key !== pass.cornerKey ||
				corner.order !== pass.cornerOrder
			);
		})
	)
		throw stale();
};

const assertStoredMatchesCommand = (
	stored: {
		batch: typeof cornerEvidenceBatch.$inferSelect;
		measurement: CornerEvidenceMeasurement;
	},
	command: CommitCornerEvidenceCommand,
): void => {
	const batch = stored.batch;
	if (
		batch.artifactId !== command.artifactId ||
		batch.ownerId !== command.ownerId ||
		batch.analysisId !== command.analysisId ||
		batch.runId !== command.runId ||
		batch.workflowId !== command.workflowId ||
		batch.segmentId !== command.segmentId ||
		batch.attemptId !== command.attemptId ||
		batch.profileDigest !== command.profileDigest ||
		batch.specificationDigest !== command.specificationDigest ||
		batch.preparedMediaId !== command.preparedMediaId ||
		batch.observationObjectKey !== command.observationObjectKey ||
		batch.observationChecksumSha256 !== command.observationChecksumSha256 ||
		batch.observationContractDigest !== command.observationContractDigest ||
		batch.manifestObjectKey !== command.manifestObjectKey ||
		batch.manifestChecksumSha256 !== command.manifestChecksumSha256 ||
		batch.approvedTrackMapVersionId !== command.approvedTrackMapVersionId ||
		batch.measurementVersion !== command.measurement.version ||
		batch.measurementInputDigest !== command.measurementInputDigest ||
		batch.measurementDigest !== command.measurementDigest ||
		batch.createdAt !== command.createdAt ||
		JSON.stringify(stored.measurement) !== JSON.stringify(command.measurement)
	)
		throw stale();
};

const batchMatchesSource = (
	batch: typeof cornerEvidenceBatch.$inferSelect,
	source: {
		ownerId: string;
		analysisId: string;
		runId: string;
		workflowId: string;
		segmentId: string;
		artifactId: string;
		attemptId: string;
		profileDigest: string;
		specificationDigest: string;
		preparedMediaId: string;
		acceptedObjectKey: string;
		observationChecksumSha256: string;
		observationContractDigest: string;
		manifestObjectKey: string;
		manifestChecksumSha256: string;
		approvedTrackMapVersionId: string;
	},
): boolean =>
	batch.ownerId === source.ownerId &&
	batch.analysisId === source.analysisId &&
	batch.runId === source.runId &&
	batch.workflowId === source.workflowId &&
	batch.segmentId === source.segmentId &&
	batch.artifactId === source.artifactId &&
	batch.attemptId === source.attemptId &&
	batch.profileDigest === source.profileDigest &&
	batch.specificationDigest === source.specificationDigest &&
	batch.preparedMediaId === source.preparedMediaId &&
	batch.observationObjectKey === source.acceptedObjectKey &&
	batch.observationChecksumSha256 === source.observationChecksumSha256 &&
	batch.observationContractDigest === source.observationContractDigest &&
	batch.manifestObjectKey === source.manifestObjectKey &&
	batch.manifestChecksumSha256 === source.manifestChecksumSha256 &&
	batch.approvedTrackMapVersionId === source.approvedTrackMapVersionId;

const chunks = <T>(values: readonly T[], size: number): T[][] => {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size)
		result.push(values.slice(index, index + size));
	return result;
};

const stale = (): CornerEvidenceAuthorityError =>
	new CornerEvidenceAuthorityError('STALE_AUTHORITY');

const retryable = (): CornerEvidenceAuthorityError =>
	new CornerEvidenceAuthorityError('RETRYABLE_INFRASTRUCTURE');
