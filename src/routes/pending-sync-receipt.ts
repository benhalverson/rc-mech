import { and, eq, exists, type SQL, sql } from 'drizzle-orm';
import type { db } from '../db';
import { syncOperation } from '../schema';

/**
 * SQL witness shared by synchronization mutation batches. Rechecks the exact
 * owner/operation/hash pending receipt at write time, because two requests can
 * both read pending before the first one commits its terminal outcome.
 */
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

/**
 * Builds bound literal projections for receipt-guarded INSERT ... SELECT writes.
 * Uses table column order because Drizzle requires the selection to match the
 * insert schema; callers supply every stored value, including explicit defaults.
 */
export const syncInsertSelection = <T extends Record<string, unknown>>(
	values: T,
	columns: Readonly<Record<keyof T, unknown>>,
): { [K in keyof T]: SQL.Aliased<T[K]> } =>
	Object.fromEntries(
		Object.keys(columns).map((key) => [key, sql`${values[key]}`.as(key)]),
	) as { [K in keyof T]: SQL.Aliased<T[K]> };
