import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from 'drizzle-orm/sqlite-core';

export const analysisDeletion = sqliteTable(
	'analysis_deletion',
	{
		ownerId: text('owner_id').notNull(),
		analysisId: text('analysis_id').notNull(),
		requestedAt: text('requested_at').notNull(),
		deletedAt: text('deleted_at'),
		nextCleanupAt: text('next_cleanup_at').notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.ownerId, table.analysisId] }),
		index('analysis_deletion_cleanup').on(table.nextCleanupAt),
	],
);

export const analysisRetryCommand = sqliteTable(
	'analysis_retry_command',
	{
		ownerId: text('owner_id').notNull(),
		commandId: text('command_id').notNull(),
		analysisId: text('analysis_id').notNull(),
		expectedStateVersion: integer('expected_state_version').notNull(),
		workflowId: text('workflow_id').notNull(),
		createdAt: text('created_at').notNull(),
	},
	(table) => [primaryKey({ columns: [table.ownerId, table.commandId] })],
);

export const preparationIntent = sqliteTable(
	'preparation_intent',
	{
		preparedMediaId: text('prepared_media_id').primaryKey(),
		ownerId: text('owner_id').notNull(),
		runId: text('run_id').notNull(),
		state: text('state', { enum: ['preparing', 'deleting'] }).notNull(),
		deleteAfter: text('delete_after').notNull(),
	},
	(table) => [index('preparation_intent_cleanup').on(table.deleteAfter)],
);

export const analysisMediaScan = sqliteTable('analysis_media_scan', {
	name: text('name').primaryKey(),
	cursor: text('cursor'),
});
