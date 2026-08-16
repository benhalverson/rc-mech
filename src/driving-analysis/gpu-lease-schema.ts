import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const gpuWaiters = sqliteTable(
	'gpu_waiters',
	{
		segmentId: text('segment_id').primaryKey(),
		deadlineAt: integer('deadline_at').notNull(),
		kind: text('kind').notNull(),
		ordinal: integer('ordinal').notNull(),
	},
	(table) => [
		uniqueIndex('gpu_waiters_ordinal').on(table.ordinal),
		index('gpu_waiters_fifo').on(table.ordinal),
	],
);

export const gpuLease = sqliteTable(
	'gpu_lease',
	{
		singleton: integer('singleton').primaryKey(),
		segmentId: text('segment_id').notNull(),
		leaseId: text('lease_id').notNull(),
		fence: integer('fence').notNull(),
		expiresAt: integer('expires_at').notNull(),
		holdExpiresAt: integer('hold_expires_at'),
		deadlineAt: integer('deadline_at').notNull(),
		kind: text('kind').notNull(),
		ordinal: integer('ordinal').notNull(),
		holdId: text('hold_id'),
	},
	(table) => [uniqueIndex('gpu_lease_lease_id').on(table.leaseId)],
);

export const gpuMeta = sqliteTable('gpu_meta', {
	key: text('key').primaryKey(),
	value: integer('value').notNull(),
});

export const gpuTerminal = sqliteTable('gpu_terminal', {
	segmentId: text('segment_id').primaryKey(),
	reason: text('reason').notNull(),
});

export const gpuLeaseSchema = { gpuWaiters, gpuLease, gpuMeta, gpuTerminal };
