import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';

export const drivingAnalysisFlag = sqliteTable('driving_analysis_flag', {
	id: integer('id').primaryKey(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
});
