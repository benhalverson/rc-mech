import { and, eq, exists, type SQL, sql } from 'drizzle-orm';
import type { db } from '../db';
import { syncOperation } from '../schema';

/** In-flight duplicates cannot write after another request completes the receipt. */
export const pendingSyncReceipt = (
	database: ReturnType<typeof db>,
	ownerId: string,
	operationId: string,
	requestHash: string,
) =>
	exists(
		database
			.select({ operationId: syncOperation.operationId })
			.from(syncOperation)
			.where(
				and(
					eq(syncOperation.ownerId, ownerId),
					eq(syncOperation.operationId, operationId),
					eq(syncOperation.requestHash, requestHash),
					eq(syncOperation.outcome, 'pending'),
				),
			),
	);

/** Bound literals for an INSERT ... SELECT guarded by its pending receipt. */
export const syncInsertSelection = <T extends Record<string, unknown>>(
	values: T,
	columns: Readonly<Record<keyof T, unknown>>,
): { [K in keyof T]: SQL.Aliased<T[K]> } =>
	Object.fromEntries(
		Object.keys(columns).map((key) => [key, sql`${values[key]}`.as(key)]),
	) as { [K in keyof T]: SQL.Aliased<T[K]> };
