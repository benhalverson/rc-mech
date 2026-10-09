import { and, eq, exists, getTableColumns, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
	applyMaintenanceChange,
	type ConsumableRecord,
	type MaintenanceCollection,
	maintenanceBaseMatches,
} from '../../../shared/maintenance-sync';
import type { consumableChangeInput } from '../../consumable-sync-contract';
import { db } from '../../db';
import {
	car,
	consumableMaintenanceEntry as entry,
	maintenancePlan,
	serviceRecord,
	syncOperation,
} from '../../schema';
import { type AppContext, consumableInput } from '../../types';
import { ownedCar } from './car-records';
import type { SyncContext } from './maintenance-sync';

/**
 * Applies an owner's durable Consumable command inside Car sync admission. Compares
 * the saved base and uses one conditional database batch for record changes and
 * the operation receipt. Car-version and pending-receipt witnesses prevent a
 * concurrent edit or in-flight duplicate from repeating child writes.
 */
export const applyConsumableSyncOperation = async (
	c: AppContext,
	context: SyncContext,
	change: z.infer<typeof consumableChangeInput>,
): Promise<Response> => {
	const { operationId, requestHash, now, requireTerminalReceipt } = context;
	const database = db(c.env);
	const ownerId = c.get('userId');
	const receiptPending = exists(
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
	const pending = and(
		eq(syncOperation.ownerId, ownerId),
		eq(syncOperation.operationId, operationId),
		eq(syncOperation.requestHash, requestHash),
		eq(syncOperation.outcome, 'pending'),
	);
	const complete = async (
		response: Readonly<Record<string, unknown>>,
		status: number,
	) => {
		await database
			.update(syncOperation)
			.set({
				outcome: String(response['outcome']),
				httpStatus: status,
				responseJson: JSON.stringify(response),
				completedAt: now,
			})
			.where(pending)
			.run();
		return requireTerminalReceipt();
	};
	const reject = (message: string, status = 409) =>
		complete(
			{
				operationId,
				outcome: 'rejected',
				error: { code: 'CONSUMABLE_REJECTED', message },
			},
			status,
		);
	const parent = await ownedCar(c, change.carId);
	if (!parent) return reject('Car not found', 404);
	if (parent.archivedAt !== null)
		return reject('Restore this Car before changing Consumable maintenance');
	const read = async (version: number): Promise<MaintenanceCollection> => ({
		carId: parent.id,
		version,
		plans: (await database
			.select()
			.from(maintenancePlan)
			.where(
				eq(maintenancePlan.carId, parent.id),
			)) as MaintenanceCollection['plans'],
		records: await database
			.select()
			.from(serviceRecord)
			.where(eq(serviceRecord.carId, parent.id)),
		consumables: (await database
			.select()
			.from(entry)
			.where(
				eq(entry.carId, parent.id),
			)) as MaintenanceCollection['consumables'],
	});
	const collection = await read(parent.version);
	const current =
		collection.consumables?.find((value) => value.id === change.entryId) ??
		null;
	if (
		change.base &&
		(change.base.id !== change.entryId || change.base.carId !== parent.id)
	)
		return reject('Consumable identity does not match the change', 422);
	const conflict = (remote: MaintenanceCollection) =>
		complete(
			{
				operationId,
				outcome: 'conflict',
				error: {
					code: 'CONSUMABLE_CONFLICT',
					message:
						'This Consumable entry changed after your local work. Both versions are retained.',
				},
				remote,
			},
			409,
		);
	if (!maintenanceBaseMatches(change.base, current))
		return conflict(collection);
	if (!current) {
		if (change.action !== 'save')
			return reject('A synchronized Consumable entry is required', 422);
		if (
			await database
				.select({ id: entry.id })
				.from(entry)
				.where(eq(entry.id, change.entryId))
				.get()
		)
			return reject('Consumable identity is unavailable');
	}
	if (current && change.input.kind !== current.kind)
		return reject('The Consumable kind cannot change', 422);
	if (
		change.action === 'restore'
			? !current?.archivedAt
			: Boolean(current?.archivedAt)
	)
		return reject('Invalid Consumable entry state');
	const input = change.input;
	try {
		const axle = (
			details: string | null,
			cost: number | null,
			currency: string | null,
		) =>
			details === null
				? undefined
				: {
						...JSON.parse(details),
						cost: cost ?? undefined,
						currency: currency ?? undefined,
					};
		const value = consumableInput.safeParse(
			input.kind === 'tires'
				? {
						kind: 'tires',
						performedAt: input.performedAt,
						notes: input.notes ?? undefined,
						front: axle(
							input.frontDetails,
							input.frontCost,
							input.frontCurrency,
						),
						rear: axle(input.rearDetails, input.rearCost, input.rearCurrency),
					}
				: {
						kind: 'fluid',
						performedAt: input.performedAt,
						notes: input.notes ?? undefined,
						fluidArea: input.fluidArea,
						customFluidArea: input.customFluidArea ?? undefined,
						cost: input.cost ?? undefined,
						currency: input.currency ?? undefined,
					},
		);
		if (!value.success) return reject('Consumable details need attention', 422);
	} catch {
		return reject('Consumable details need attention', 422);
	}
	const version = parent.version + 1;
	const next = applyMaintenanceChange(
		{ ...collection, version },
		change,
		now,
		0,
	);
	const saved = next.consumables?.find(
		(value) => value.id === change.entryId,
	) as ConsumableRecord;
	const witness = and(
		receiptPending,
		exists(
			database
				.select({ id: car.id })
				.from(car)
				.where(
					and(
						eq(car.id, parent.id),
						eq(car.ownerId, ownerId),
						eq(car.version, version),
						eq(car.lastOperationId, operationId),
						isNull(car.archivedAt),
					),
				),
		),
	);
	const columns = getTableColumns(entry);
	const unchanged = current
		? exists(
				database
					.select({ id: entry.id })
					.from(entry)
					.where(
						and(
							...Object.entries(current).map(
								([key, value]) =>
									sql`${columns[key as keyof typeof columns]} IS ${value}`,
							),
						),
					),
			)
		: undefined;
	const mutation = current
		? database
				.update(entry)
				.set(saved)
				.where(and(eq(entry.id, saved.id), eq(entry.carId, parent.id), witness))
		: database.insert(entry).select(
				database
					.select({
						id: sql<string>`${saved.id}`.as('id'),
						carId: sql<string>`${saved.carId}`.as('carId'),
						kind: sql<string>`${saved.kind}`.as('kind'),
						performedAt: sql<string>`${saved.performedAt}`.as('performedAt'),
						fluidArea: sql<string | null>`${saved.fluidArea}`.as('fluidArea'),
						customFluidArea: sql<string | null>`${saved.customFluidArea}`.as(
							'customFluidArea',
						),
						frontDetails: sql<string | null>`${saved.frontDetails}`.as(
							'frontDetails',
						),
						frontCost: sql<number | null>`${saved.frontCost}`.as('frontCost'),
						frontCurrency: sql<string | null>`${saved.frontCurrency}`.as(
							'frontCurrency',
						),
						rearDetails: sql<string | null>`${saved.rearDetails}`.as(
							'rearDetails',
						),
						rearCost: sql<number | null>`${saved.rearCost}`.as('rearCost'),
						rearCurrency: sql<string | null>`${saved.rearCurrency}`.as(
							'rearCurrency',
						),
						cost: sql<number | null>`${saved.cost}`.as('cost'),
						currency: sql<string | null>`${saved.currency}`.as('currency'),
						notes: sql<string | null>`${saved.notes}`.as('notes'),
						prefilledFromSetupId: sql<
							string | null
						>`${saved.prefilledFromSetupId}`.as('prefilledFromSetupId'),
						archivedAt: sql<string | null>`${saved.archivedAt}`.as(
							'archivedAt',
						),
						createdAt: sql<string>`${saved.createdAt}`.as('createdAt'),
						updatedAt: sql<string>`${saved.updatedAt}`.as('updatedAt'),
					})
					.from(car)
					.where(and(eq(car.id, parent.id), witness)),
			);
	const response = { operationId, outcome: 'applied', collection: next };
	const batch = await database.batch([
		database
			.update(car)
			.set({ version, lastOperationId: operationId })
			.where(
				and(
					eq(car.id, parent.id),
					eq(car.ownerId, ownerId),
					eq(car.version, parent.version),
					receiptPending,
					isNull(car.archivedAt),
					unchanged,
				),
			),
		mutation,
		database
			.update(syncOperation)
			.set({
				outcome: 'applied',
				httpStatus: 200,
				responseJson: JSON.stringify(response),
				completedAt: now,
			})
			.where(and(pending, witness)),
	]);
	if (batch[0].meta.changes === 0) {
		const latest = await ownedCar(c, parent.id);
		if (!latest || latest.archivedAt !== null)
			return reject('Car is no longer available for Consumable maintenance');
		return conflict(await read(latest.version));
	}
	return requireTerminalReceipt();
};
