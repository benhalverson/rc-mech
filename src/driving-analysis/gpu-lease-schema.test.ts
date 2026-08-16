import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, test } from 'vitest';
import {
	gpuLease,
	gpuLeaseSchema,
	gpuMeta,
	gpuTerminal,
	gpuWaiters,
} from './gpu-lease-schema';

describe('GPU lease SQLite schema', () => {
	test('defines the coordinator tables, columns, and indexes', () => {
		expect(gpuLeaseSchema).toEqual({
			gpuWaiters,
			gpuLease,
			gpuMeta,
			gpuTerminal,
		});

		expect(getTableConfig(gpuWaiters)).toMatchObject({
			name: 'gpu_waiters',
			columns: [
				{ name: 'segment_id', notNull: true, primary: true },
				{ name: 'deadline_at', notNull: true, primary: false },
				{ name: 'kind', notNull: true, primary: false },
				{ name: 'ordinal', notNull: true, primary: false },
			],
			indexes: [
				{ config: { name: 'gpu_waiters_ordinal', unique: true } },
				{ config: { name: 'gpu_waiters_fifo', unique: false } },
			],
		});
		expect(getTableConfig(gpuLease)).toMatchObject({
			name: 'gpu_lease',
			columns: [
				{ name: 'singleton', notNull: true, primary: true },
				{ name: 'segment_id', notNull: true, primary: false },
				{ name: 'lease_id', notNull: true, primary: false },
				{ name: 'fence', notNull: true, primary: false },
				{ name: 'expires_at', notNull: true, primary: false },
				{ name: 'hold_expires_at', notNull: false, primary: false },
				{ name: 'deadline_at', notNull: true, primary: false },
				{ name: 'kind', notNull: true, primary: false },
				{ name: 'ordinal', notNull: true, primary: false },
				{ name: 'hold_id', notNull: false, primary: false },
			],
			indexes: [{ config: { name: 'gpu_lease_lease_id', unique: true } }],
		});
		expect(getTableConfig(gpuMeta)).toMatchObject({
			name: 'gpu_meta',
			columns: [
				{ name: 'key', notNull: true, primary: true },
				{ name: 'value', notNull: true, primary: false },
			],
			indexes: [],
		});
		expect(getTableConfig(gpuTerminal)).toMatchObject({
			name: 'gpu_terminal',
			columns: [
				{ name: 'segment_id', notNull: true, primary: true },
				{ name: 'reason', notNull: true, primary: false },
			],
			indexes: [],
		});
	});
});
