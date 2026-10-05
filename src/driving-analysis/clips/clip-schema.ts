import {
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { drivingAnalysis, trackCorner } from '../../schema';
import { cornerEvidenceBatch } from '../evidence/evidence-schema';
import { trackingRun } from '../tracking/authority-schema';

export const cornerClip = sqliteTable(
	'corner_clip',
	{
		id: text('id').primaryKey(),
		inputDigest: text('input_digest').notNull().unique(),
		ownerId: text('owner_id').notNull(),
		analysisId: text('analysis_id')
			.notNull()
			.references(() => drivingAnalysis.id),
		runId: text('run_id')
			.notNull()
			.references(() => trackingRun.id),
		workflowId: text('workflow_id').notNull(),
		batchArtifactId: text('batch_artifact_id')
			.notNull()
			.references(() => cornerEvidenceBatch.artifactId),
		cornerId: text('corner_id')
			.notNull()
			.references(() => trackCorner.id),
		ordinal: integer('pass_ordinal').notNull(),
		specificationJson: text('specification_json').notNull(),
		sourceObjectKey: text('source_object_key').notNull(),
		sourceByteCount: integer('source_byte_count').notNull(),
		createdAt: text('created_at').notNull(),
	},
	(table) => [
		uniqueIndex('corner_clip_pass').on(
			table.batchArtifactId,
			table.cornerId,
			table.ordinal,
		),
	],
);

export const cornerClipPublication = sqliteTable('corner_clip_publication', {
	clipId: text('clip_id')
		.primaryKey()
		.references(() => cornerClip.id),
	objectKey: text('object_key').notNull().unique(),
	checksum: text('checksum').notNull(),
	byteCount: integer('byte_count').notNull(),
	renderInputDigest: text('render_input_digest').notNull(),
	durationMs: integer('duration_ms').notNull(),
	createdAt: text('created_at').notNull(),
});
