import { sql } from 'drizzle-orm';
import {
	check,
	foreignKey,
	index,
	integer,
	primaryKey,
	sqliteTable,
	sqliteView,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const inferenceProfileAuthority = sqliteTable(
	'inference_profile',
	{
		profileDigest: text('profile_digest').primaryKey(),
		contractVersion: text('contract_version').notNull(),
		canonicalizationVersion: text('canonicalization_version').notNull(),
		configurationJson: text('configuration_json').notNull(),
		createdAt: text('created_at').notNull(),
	},
	(table) => [
		check(
			'inference_profile_digest_length',
			sql`length(${table.profileDigest}) = 64`,
		),
	],
);

export const trackingRun = sqliteTable(
	'tracking_run',
	{
		id: text('id').primaryKey(),
		analysisId: text('analysis_id').notNull(),
		ownerId: text('owner_id').notNull(),
		sequence: integer('run_sequence').notNull(),
		workflowId: text('workflow_id').notNull(),
		profileDigest: text('profile_digest')
			.notNull()
			.references(() => inferenceProfileAuthority.profileDigest),
		inputDigest: text('input_digest').notNull(),
		status: text('status', {
			enum: ['active', 'completed', 'cancelled', 'replaced', 'failed'],
		})
			.notNull()
			.default('active'),
		version: integer('version').notNull().default(1),
		createdAt: text('created_at').notNull(),
		completedAt: text('completed_at'),
	},
	(table) => [
		uniqueIndex('tracking_run_analysis_sequence').on(
			table.analysisId,
			table.sequence,
		),
		uniqueIndex('tracking_run_workflow').on(table.workflowId),
		index('tracking_run_owner_analysis').on(table.ownerId, table.analysisId),
		check('tracking_run_sequence_positive', sql`${table.sequence} > 0`),
		check('tracking_run_version_positive', sql`${table.version} > 0`),
		check(
			'tracking_run_input_digest_length',
			sql`length(${table.inputDigest}) = 64`,
		),
	],
);

export const preparedTrackingMedia = sqliteTable(
	'prepared_tracking_media',
	{
		id: text('id').primaryKey(),
		runId: text('run_id')
			.notNull()
			.references(() => trackingRun.id),
		descriptorJson: text('descriptor_json').notNull(),
		preparationInputDigest: text('preparation_input_digest').notNull(),
		preparedChecksum: text('prepared_checksum').notNull(),
		frameManifestChecksum: text('frame_manifest_checksum').notNull(),
		sourceChecksum: text('source_checksum').notNull(),
		windowStartTimestampMs: integer('window_start_timestamp_ms').notNull(),
		windowEndTimestampMs: integer('window_end_timestamp_ms').notNull(),
		createdAt: text('created_at').notNull(),
	},
	(table) => [
		uniqueIndex('prepared_tracking_media_run').on(table.runId),
		uniqueIndex('prepared_tracking_media_identity').on(table.id, table.runId),
		check(
			'prepared_tracking_media_window',
			sql`${table.windowEndTimestampMs} > ${table.windowStartTimestampMs}`,
		),
	],
);

export const trackingRunInput = sqliteTable(
	'tracking_run_input',
	{
		runId: text('run_id')
			.primaryKey()
			.references(() => trackingRun.id),
		ownerId: text('owner_id').notNull(),
		raceVideoId: text('race_video_id').notNull(),
		sourceObjectKey: text('source_object_key').notNull(),
		sourceByteCount: integer('source_byte_count').notNull(),
		sourceChecksum: text('source_checksum').notNull(),
		windowStartTimestampMs: integer('window_start_timestamp_ms').notNull(),
		windowEndTimestampMs: integer('window_end_timestamp_ms').notNull(),
		approvedTrackMapVersionId: text('approved_track_map_version_id').notNull(),
		sourceLayoutVersion: text('source_layout_version').notNull(),
		sourceLayoutDigest: text('source_layout_digest').notNull(),
		sourceWidth: integer('source_width').notNull(),
		sourceHeight: integer('source_height').notNull(),
		inputDigest: text('input_digest').notNull(),
		createdAt: text('created_at').notNull(),
	},
	(table) => [
		index('tracking_run_input_owner').on(table.ownerId, table.runId),
		check('tracking_run_input_source_bytes', sql`${table.sourceByteCount} > 0`),
		check(
			'tracking_run_input_source_checksum',
			sql`length(${table.sourceChecksum}) = 64`,
		),
		check(
			'tracking_run_input_window',
			sql`${table.windowEndTimestampMs} > ${table.windowStartTimestampMs}`,
		),
		check(
			'tracking_run_input_layout_digest',
			sql`length(${table.sourceLayoutDigest}) = 64`,
		),
		check(
			'tracking_run_input_dimensions',
			sql`${table.sourceWidth} > 0 AND ${table.sourceHeight} > 0`,
		),
		check('tracking_run_input_digest', sql`length(${table.inputDigest}) = 64`),
	],
);

export const preparedTrackingObject = sqliteTable(
	'prepared_tracking_object',
	{
		preparedMediaId: text('prepared_media_id').notNull(),
		runId: text('run_id').notNull(),
		role: text('role', {
			enum: ['prepared-media', 'frame-manifest'],
		}).notNull(),
		objectKey: text('object_key').notNull().unique(),
		byteCount: integer('byte_count').notNull(),
		checksumSha256: text('checksum_sha256').notNull(),
		contentType: text('content_type').notNull(),
		contentEncoding: text('content_encoding'),
		createdAt: text('created_at').notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.preparedMediaId, table.role] }),
		foreignKey({
			columns: [table.preparedMediaId, table.runId],
			foreignColumns: [preparedTrackingMedia.id, preparedTrackingMedia.runId],
		}),
		index('prepared_tracking_object_run').on(table.runId),
		check('prepared_tracking_object_bytes', sql`${table.byteCount} > 0`),
		check(
			'prepared_tracking_object_checksum',
			sql`length(${table.checksumSha256}) = 64`,
		),
		check(
			'prepared_tracking_object_media',
			sql`(${table.role} = 'prepared-media' AND ${table.contentType} = 'video/mp4' AND ${table.contentEncoding} IS NULL) OR (${table.role} = 'frame-manifest' AND ${table.contentType} = 'application/vnd.rc-mech.prepared-frame-manifest+json' AND ${table.contentEncoding} = 'gzip')`,
		),
	],
);

export const preparedTrackingRetention = sqliteTable(
	'prepared_tracking_retention',
	{
		runId: text('run_id')
			.primaryKey()
			.references(() => trackingRun.id),
		preparedMediaId: text('prepared_media_id')
			.notNull()
			.unique()
			.references(() => preparedTrackingMedia.id),
		deleteAfter: text('delete_after').notNull(),
		state: text('state', { enum: ['active', 'deleted'] })
			.notNull()
			.default('active'),
		version: integer('version').notNull().default(1),
		deletedAt: text('deleted_at'),
		createdAt: text('created_at').notNull(),
		updatedAt: text('updated_at').notNull(),
	},
	(table) => [
		index('prepared_tracking_retention_cleanup').on(
			table.state,
			table.deleteAfter,
		),
		check('prepared_tracking_retention_version', sql`${table.version} > 0`),
		check(
			'prepared_tracking_retention_state',
			sql`(${table.state} = 'active' AND ${table.deletedAt} IS NULL) OR (${table.state} = 'deleted' AND ${table.deletedAt} IS NOT NULL)`,
		),
	],
);

export const trackingSegment = sqliteTable(
	'tracking_segment',
	{
		id: text('id').primaryKey(),
		runId: text('run_id')
			.notNull()
			.references(() => trackingRun.id),
		order: integer('segment_order').notNull(),
		seedKind: text('seed_kind', {
			enum: ['initial', 'reidentification'],
		}).notNull(),
		seedSourceId: text('seed_source_id'),
		seedJson: text('seed_json').notNull(),
		preparedMediaId: text('prepared_media_id')
			.notNull()
			.references(() => preparedTrackingMedia.id),
		raceWindowEndTimestampMs: integer('race_window_end_timestamp_ms').notNull(),
		profileDigest: text('profile_digest')
			.notNull()
			.references(() => inferenceProfileAuthority.profileDigest),
		specificationVersion: text('specification_version').notNull(),
		specificationDigest: text('specification_digest').notNull(),
		availabilityDeadlineAt: integer('availability_deadline_at').notNull(),
		currentAttemptId: text('current_attempt_id'),
		authorityLeaseId: text('authority_lease_id'),
		authorityFence: integer('authority_fence'),
		outcome: text('outcome', { enum: ['completed', 'tracking-gap'] }),
		gapJson: text('gap_json'),
		acceptedArtifactId: text('accepted_artifact_id'),
		version: integer('version').notNull().default(1),
		createdAt: text('created_at').notNull(),
	},
	(table) => [
		uniqueIndex('tracking_segment_run_order').on(table.runId, table.order),
		uniqueIndex('tracking_segment_specification').on(
			table.runId,
			table.specificationDigest,
		),
		index('tracking_segment_current_attempt').on(table.currentAttemptId),
		check('tracking_segment_order_nonnegative', sql`${table.order} >= 0`),
		check(
			'tracking_segment_seed_source',
			sql`(${table.seedKind} = 'initial' AND ${table.seedSourceId} IS NULL) OR (${table.seedKind} = 'reidentification' AND ${table.seedSourceId} IS NOT NULL)`,
		),
		check(
			'tracking_segment_authority_complete',
			sql`(${table.currentAttemptId} IS NULL AND ${table.authorityLeaseId} IS NULL AND ${table.authorityFence} IS NULL) OR (${table.currentAttemptId} IS NOT NULL AND ${table.authorityLeaseId} IS NOT NULL AND ${table.authorityFence} > 0)`,
		),
		check(
			'tracking_segment_outcome_artifact',
			sql`(${table.outcome} IS NULL AND ${table.acceptedArtifactId} IS NULL AND ${table.gapJson} IS NULL) OR (${table.outcome} = 'completed' AND ${table.acceptedArtifactId} IS NOT NULL AND ${table.gapJson} IS NULL) OR (${table.outcome} = 'tracking-gap' AND ${table.acceptedArtifactId} IS NOT NULL AND ${table.gapJson} IS NOT NULL)`,
		),
	],
);

export const trackingExecutionAttempt = sqliteTable(
	'tracking_execution_attempt',
	{
		id: text('id').primaryKey(),
		segmentId: text('segment_id')
			.notNull()
			.references(() => trackingSegment.id),
		profileDigest: text('profile_digest').notNull(),
		specificationDigest: text('specification_digest').notNull(),
		leaseId: text('lease_id').notNull(),
		fence: integer('fence').notNull(),
		state: text('state', {
			enum: [
				'proposed',
				'active',
				'transferring',
				'processing',
				'output-ready',
				'completed',
				'failed',
				'cancelled',
				'expired',
				'replaced',
			],
		}).notNull(),
		progress: integer('progress').notNull().default(0),
		safeFailureCode: text('safe_failure_code'),
		version: integer('version').notNull().default(1),
		createdAt: text('created_at').notNull(),
		updatedAt: text('updated_at').notNull(),
	},
	(table) => [
		index('tracking_attempt_segment').on(table.segmentId),
		uniqueIndex('tracking_attempt_lease_fence').on(table.leaseId, table.fence),
		check('tracking_attempt_fence_positive', sql`${table.fence} > 0`),
		check(
			'tracking_attempt_progress',
			sql`${table.progress} >= 0 AND ${table.progress} <= 99`,
		),
	],
);

export const trackingTransferRequest = sqliteTable(
	'tracking_transfer_request',
	{
		id: text('id').primaryKey(),
		attemptId: text('attempt_id')
			.notNull()
			.references(() => trackingExecutionAttempt.id),
		role: text('role', {
			enum: ['prepared-media', 'frame-manifest', 'observation-artifact'],
		}).notNull(),
		method: text('method', { enum: ['GET', 'PUT'] }).notNull(),
		objectScope: text('object_scope').notNull(),
		state: text('state', { enum: ['required', 'granted', 'completed'] })
			.notNull()
			.default('required'),
		version: integer('version').notNull().default(1),
		createdAt: text('created_at').notNull(),
		updatedAt: text('updated_at').notNull(),
	},
	(table) => [
		uniqueIndex('tracking_transfer_attempt_role').on(
			table.attemptId,
			table.role,
		),
		check(
			'tracking_transfer_method_role',
			sql`(${table.role} = 'observation-artifact' AND ${table.method} = 'PUT') OR (${table.role} <> 'observation-artifact' AND ${table.method} = 'GET')`,
		),
	],
);

export const trackingArtifactPromotion = sqliteTable(
	'tracking_artifact_promotion',
	{
		artifactId: text('artifact_id').primaryKey(),
		runId: text('run_id')
			.notNull()
			.references(() => trackingRun.id),
		segmentId: text('segment_id')
			.notNull()
			.references(() => trackingSegment.id),
		attemptId: text('attempt_id')
			.notNull()
			.references(() => trackingExecutionAttempt.id),
		transferRequestId: text('transfer_request_id')
			.notNull()
			.references(() => trackingTransferRequest.id),
		stagingObjectKey: text('staging_object_key').notNull(),
		acceptedObjectKey: text('accepted_object_key').notNull(),
		checksumSha256: text('checksum_sha256').notNull(),
		contractDigest: text('contract_digest').notNull(),
		byteCount: integer('byte_count').notNull(),
		state: text('state', {
			enum: ['pending', 'promoted', 'accepted', 'deleting', 'deleted'],
		})
			.notNull()
			.default('pending'),
		deleteAfter: text('delete_after').notNull(),
		version: integer('version').notNull().default(1),
		createdAt: text('created_at').notNull(),
		updatedAt: text('updated_at').notNull(),
		deletedAt: text('deleted_at'),
	},
	(table) => [
		uniqueIndex('tracking_artifact_promotion_transfer').on(
			table.transferRequestId,
		),
		uniqueIndex('tracking_artifact_promotion_staging').on(
			table.stagingObjectKey,
		),
		uniqueIndex('tracking_artifact_promotion_accepted').on(
			table.acceptedObjectKey,
		),
		index('tracking_artifact_promotion_cleanup').on(
			table.state,
			table.deleteAfter,
		),
		check(
			'tracking_artifact_promotion_checksum',
			sql`length(${table.checksumSha256}) = 64`,
		),
		check(
			'tracking_artifact_promotion_contract_digest',
			sql`length(${table.contractDigest}) = 64`,
		),
		check('tracking_artifact_promotion_bytes', sql`${table.byteCount} > 0`),
		check('tracking_artifact_promotion_version', sql`${table.version} > 0`),
		check(
			'tracking_artifact_promotion_deleted',
			sql`(${table.state} = 'deleted' AND ${table.deletedAt} IS NOT NULL) OR (${table.state} <> 'deleted' AND ${table.deletedAt} IS NULL)`,
		),
	],
);

export const subjectObservationArtifact = sqliteTable(
	'subject_observation_artifact',
	{
		id: text('id').primaryKey(),
		runId: text('run_id')
			.notNull()
			.references(() => trackingRun.id),
		segmentId: text('segment_id')
			.notNull()
			.references(() => trackingSegment.id),
		attemptId: text('attempt_id')
			.notNull()
			.references(() => trackingExecutionAttempt.id),
		profileDigest: text('profile_digest').notNull(),
		specificationDigest: text('specification_digest').notNull(),
		leaseId: text('lease_id').notNull(),
		fence: integer('fence').notNull(),
		acceptedObjectKey: text('accepted_object_key').notNull(),
		checksumSha256: text('checksum_sha256').notNull(),
		contractDigest: text('contract_digest').notNull(),
		byteCount: integer('byte_count').notNull(),
		outcome: text('outcome', { enum: ['completed', 'tracking-gap'] }).notNull(),
		gapJson: text('gap_json'),
		firstTimestampMs: integer('first_timestamp_ms'),
		lastTimestampMs: integer('last_timestamp_ms'),
		createdAt: text('created_at').notNull(),
	},
	(table) => [
		uniqueIndex('subject_observation_artifact_segment').on(table.segmentId),
		uniqueIndex('subject_observation_artifact_object').on(
			table.acceptedObjectKey,
		),
		check('subject_observation_artifact_fence', sql`${table.fence} > 0`),
		check('subject_observation_artifact_bytes', sql`${table.byteCount} > 0`),
		check(
			'subject_observation_artifact_gap',
			sql`(${table.outcome} = 'completed' AND ${table.gapJson} IS NULL) OR (${table.outcome} = 'tracking-gap' AND ${table.gapJson} IS NOT NULL)`,
		),
	],
);

export const trackingPublicProvenance = sqliteView(
	'tracking_public_provenance',
	{
		ownerId: text('owner_id'),
		analysisId: text('analysis_id'),
		runId: text('run_id'),
		profileDigest: text('profile_digest'),
		segmentId: text('segment_id'),
		segmentOrder: integer('segment_order'),
		outcome: text('outcome', { enum: ['completed', 'tracking-gap'] }),
		gapJson: text('gap_json'),
		artifactId: text('artifact_id'),
		artifactDigest: text('artifact_digest'),
		contractDigest: text('contract_digest'),
		byteCount: integer('byte_count'),
	},
).existing();

export const trackingAuthoritySchema = {
	inferenceProfileAuthority,
	trackingRun,
	preparedTrackingMedia,
	trackingRunInput,
	preparedTrackingObject,
	preparedTrackingRetention,
	trackingSegment,
	trackingExecutionAttempt,
	trackingTransferRequest,
	trackingArtifactPromotion,
	subjectObservationArtifact,
	trackingPublicProvenance,
};
