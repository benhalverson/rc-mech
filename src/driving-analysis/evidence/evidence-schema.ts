import { sql } from 'drizzle-orm';
import {
	check,
	foreignKey,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { drivingAnalysis, trackCorner, trackMapVersion } from '../../schema';
import {
	preparedTrackingMedia,
	subjectObservationArtifact,
	trackingExecutionAttempt,
	trackingRun,
	trackingSegment,
} from '../tracking/authority-schema';

export const cornerEvidenceBatch = sqliteTable(
	'corner_evidence_batch',
	{
		artifactId: text('artifact_id')
			.primaryKey()
			.references(() => subjectObservationArtifact.id),
		ownerId: text('owner_id').notNull(),
		analysisId: text('analysis_id')
			.notNull()
			.references(() => drivingAnalysis.id),
		runId: text('run_id')
			.notNull()
			.references(() => trackingRun.id),
		workflowId: text('workflow_id').notNull(),
		segmentId: text('segment_id')
			.notNull()
			.references(() => trackingSegment.id),
		attemptId: text('attempt_id')
			.notNull()
			.references(() => trackingExecutionAttempt.id),
		profileDigest: text('profile_digest').notNull(),
		specificationDigest: text('specification_digest').notNull(),
		preparedMediaId: text('prepared_media_id')
			.notNull()
			.references(() => preparedTrackingMedia.id),
		observationObjectKey: text('observation_object_key').notNull(),
		observationChecksumSha256: text('observation_checksum_sha256').notNull(),
		observationContractDigest: text('observation_contract_digest').notNull(),
		manifestObjectKey: text('manifest_object_key').notNull(),
		manifestChecksumSha256: text('manifest_checksum_sha256').notNull(),
		approvedTrackMapVersionId: text('approved_track_map_version_id')
			.notNull()
			.references(() => trackMapVersion.id),
		measurementVersion: text('measurement_version').notNull(),
		measurementInputDigest: text('measurement_input_digest').notNull(),
		measurementDigest: text('measurement_digest').notNull(),
		createdAt: text('created_at').notNull(),
	},
	(table) => [
		uniqueIndex('corner_evidence_batch_artifact_measurement').on(
			table.artifactId,
			table.measurementDigest,
		),
		check(
			'corner_evidence_batch_digests',
			sql`length(${table.profileDigest}) = 64 AND length(${table.specificationDigest}) = 64 AND length(${table.observationChecksumSha256}) = 64 AND length(${table.observationContractDigest}) = 64 AND length(${table.manifestChecksumSha256}) = 64 AND length(${table.measurementInputDigest}) = 64 AND length(${table.measurementDigest}) = 64`,
		),
	],
);

export const cornerPassEvidence = sqliteTable(
	'corner_pass_evidence',
	{
		batchArtifactId: text('batch_artifact_id')
			.notNull()
			.references(() => cornerEvidenceBatch.artifactId),
		batchMeasurementDigest: text('batch_measurement_digest').notNull(),
		cornerId: text('corner_id')
			.notNull()
			.references(() => trackCorner.id),
		cornerKey: text('corner_key').notNull(),
		cornerOrder: integer('corner_order').notNull(),
		ordinal: integer('pass_ordinal').notNull(),
		entryTimestampMs: real('entry_timestamp_ms'),
		entryBeforeFrameIndex: integer('entry_before_frame_index'),
		entryAfterFrameIndex: integer('entry_after_frame_index'),
		exitTimestampMs: real('exit_timestamp_ms'),
		exitBeforeFrameIndex: integer('exit_before_frame_index'),
		exitAfterFrameIndex: integer('exit_after_frame_index'),
		durationMs: real('duration_ms'),
		eligibility: text('eligibility', {
			enum: ['eligible', 'ineligible'],
		}).notNull(),
		exclusionReason: text('exclusion_reason', {
			enum: ['tracking-gap', 'untrusted-crossing', 'gate-order', 'race-window'],
		}),
		rank: integer('pass_rank'),
		tieGroup: integer('tie_group'),
		best: integer('best', { mode: 'boolean' }).notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.batchArtifactId, table.batchMeasurementDigest],
			foreignColumns: [
				cornerEvidenceBatch.artifactId,
				cornerEvidenceBatch.measurementDigest,
			],
		}),
		primaryKey({
			columns: [table.batchArtifactId, table.cornerId, table.ordinal],
		}),
		check(
			'corner_pass_evidence_ordinal',
			sql`length(${table.batchMeasurementDigest}) = 64 AND ${table.cornerOrder} >= 0 AND ${table.ordinal} > 0`,
		),
		check(
			'corner_pass_evidence_crossings',
			sql`(${table.entryTimestampMs} IS NULL AND ${table.entryBeforeFrameIndex} IS NULL AND ${table.entryAfterFrameIndex} IS NULL) OR (${table.entryTimestampMs} IS NOT NULL AND ${table.entryBeforeFrameIndex} IS NOT NULL AND ${table.entryAfterFrameIndex} IS NOT NULL)`,
		),
		check(
			'corner_pass_evidence_exit',
			sql`(${table.exitTimestampMs} IS NULL AND ${table.exitBeforeFrameIndex} IS NULL AND ${table.exitAfterFrameIndex} IS NULL) OR (${table.exitTimestampMs} IS NOT NULL AND ${table.exitBeforeFrameIndex} IS NOT NULL AND ${table.exitAfterFrameIndex} IS NOT NULL)`,
		),
		check(
			'corner_pass_evidence_eligibility',
			sql`(${table.eligibility} = 'eligible' AND ${table.entryTimestampMs} IS NOT NULL AND ${table.exitTimestampMs} IS NOT NULL AND ${table.durationMs} >= 0 AND ${table.exclusionReason} IS NULL AND ${table.rank} > 0 AND ${table.tieGroup} > 0) OR (${table.eligibility} = 'ineligible' AND ${table.exclusionReason} IS NOT NULL AND ${table.durationMs} IS NULL AND ${table.rank} IS NULL AND ${table.tieGroup} IS NULL AND ${table.best} = 0)`,
		),
	],
);

export const cornerEvidenceSchema = {
	cornerEvidenceBatch,
	cornerPassEvidence,
};
