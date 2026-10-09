import { and, eq, exists, getTableColumns, isNull, sql } from 'drizzle-orm';
import {
	applyMaintenanceChange,
	type MaintenanceCollection,
	maintenanceBaseMatches,
} from '../../../shared/maintenance-sync';
import { db } from '../../db';
import { maintenanceSyncCommandInput } from '../../maintenance-sync-contract';
import {
	car,
	component,
	consumableMaintenanceEntry,
	maintenancePlan,
	serviceRecord,
	syncOperation,
} from '../../schema';
import type { AppContext } from '../../types';
import { ownedCar } from './car-records';
import { applyConsumableSyncOperation } from './consumable-sync';

export type SyncContext = Readonly<{
	command: Readonly<{ type: string; carId: string }>;
	operationId: string;
	requestHash: string;
	now: string;
	requireTerminalReceipt: () => Promise<Response>;
}>;
/**
 * Applies an owner's durable Maintenance command inside Car sync admission. Compares
 * the saved base and uses one conditional database batch for record changes and
 * the operation receipt. Car-version and pending-receipt witnesses prevent a
 * concurrent edit or in-flight duplicate from repeating child writes.
 */
export const applyMaintenanceSyncOperation = async (
	c: AppContext,
	context: SyncContext,
): Promise<Response> => {
	const { command, operationId, requestHash, now, requireTerminalReceipt } =
		context;
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
				error: { code: 'MAINTENANCE_REJECTED', message },
			},
			status,
		);
	const parsed = maintenanceSyncCommandInput.safeParse(command);
	if (!parsed.success) return reject('Maintenance change needs attention', 422);
	const change = parsed.data;
	if (change.entity === 'consumable')
		return applyConsumableSyncOperation(c, context, change);
	const parent = await ownedCar(c, change.carId);
	if (!parent) return reject('Car not found', 404);
	if (parent.archivedAt !== null)
		return reject('Restore this Car before changing maintenance');
	const read = async (version: number): Promise<MaintenanceCollection> => ({
		carId: parent.id,
		version,
		consumables: (await database
			.select()
			.from(consumableMaintenanceEntry)
			.where(
				eq(consumableMaintenanceEntry.carId, parent.id),
			)) as MaintenanceCollection['consumables'],
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
	});
	const collection = await read(parent.version);
	const conflict = (remote: MaintenanceCollection) =>
		complete(
			{
				operationId,
				outcome: 'conflict',
				error: {
					code: 'MAINTENANCE_CONFLICT',
					message:
						'This maintenance record changed after your local work. Both versions are retained.',
				},
				remote,
			},
			409,
		);
	const identity = change.entity === 'plan' ? change.planId : change.recordId;
	const current =
		change.entity === 'plan'
			? (collection.plans.find((plan) => plan.id === identity) ?? null)
			: (collection.records.find((record) => record.id === identity) ?? null);
	if (
		change.base &&
		(change.base.id !== identity || change.base.carId !== parent.id)
	)
		return reject('Maintenance identity does not match the change', 422);
	if (!maintenanceBaseMatches(change.base, current))
		return conflict(collection);
	if (!current) {
		if (change.action !== 'save')
			return reject('A synchronized record is required for this action', 422);
		const collision =
			change.entity === 'plan'
				? await database
						.select({ id: maintenancePlan.id })
						.from(maintenancePlan)
						.where(eq(maintenancePlan.id, identity))
						.get()
				: await database
						.select({ id: serviceRecord.id })
						.from(serviceRecord)
						.where(eq(serviceRecord.id, identity))
						.get();
		if (collision) return reject('Maintenance identity is unavailable');
	}
	if (change.entity === 'plan') {
		const status = change.base?.status;
		if (
			(change.action === 'save' && status === 'archived') ||
			(change.action === 'pause' && status !== 'active') ||
			(change.action === 'resume' && status !== 'paused') ||
			(change.action === 'restore' && status !== 'archived') ||
			(change.action === 'archive' && status === 'archived')
		)
			return reject('Invalid maintenance plan state');
	} else {
		if ((change.input.cost === null) !== (change.input.currency === null))
			return reject('Cost and currency must be supplied together', 422);
		if (
			(change.action === 'save' || change.action === 'archive') &&
			change.base?.deletedAt
		)
			return reject('Deleted Service records are immutable');
		if (change.action === 'restore' && !change.base?.deletedAt)
			return reject('Service record is already active');
		const linked = change.planBase
			? (collection.plans.find((plan) => plan.id === change.planBase?.id) ??
				null)
			: null;
		if (
			change.planBase?.carId !== undefined &&
			change.planBase.carId !== parent.id
		)
			return reject('Maintenance plan belongs to another Car', 422);
		if (change.base && change.base.planId !== (change.planBase?.id ?? null))
			return reject('Service plan identity cannot change', 422);
		if (!maintenanceBaseMatches(change.planBase, linked))
			return conflict(collection);
		if (!change.base && linked?.status !== 'active' && linked !== null)
			return reject('Only active plans can be completed');
	}
	if (change.base && change.input.componentId !== change.base.componentId)
		return reject('The maintenance Component identity cannot change', 422);
	if (
		change.entity === 'service' &&
		!change.base &&
		change.planBase &&
		change.input.componentId !== change.planBase.componentId
	)
		return reject('Service must use its plan Component', 422);
	const componentId = change.input.componentId;
	if (componentId) {
		const installed = await database
			.select()
			.from(component)
			.where(and(eq(component.id, componentId), eq(component.carId, parent.id)))
			.get();
		if (
			!installed ||
			(change.entity === 'plan' && installed.removedAt !== null)
		)
			return reject('A matching current Component is required');
	}
	const next = applyMaintenanceChange(
		collection,
		change,
		now,
		change.entity === 'service' ? change.baselineSessionCount : 0,
	);
	const version = parent.version + 1;
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
	const selectParent = and(eq(car.id, parent.id), witness);
	const plan = next.plans.find(
		(plan) =>
			plan.id === (change.entity === 'plan' ? identity : change.planBase?.id),
	);
	const record = next.records.find((record) => record.id === identity);
	// Inserts are selected through the successful Car compare-and-swap witness.
	const planMutation = plan
		? (current && change.entity === 'plan') || change.entity === 'service'
			? database
					.update(maintenancePlan)
					.set(plan)
					.where(
						and(
							eq(maintenancePlan.id, plan.id),
							eq(maintenancePlan.carId, parent.id),
							witness,
						),
					)
			: database.insert(maintenancePlan).select(
					database
						.select({
							id: sql<string>`${plan.id}`.as('id'),
							carId: sql<string>`${plan.carId}`.as('carId'),
							componentId: sql<string | null>`${plan.componentId}`.as(
								'componentId',
							),
							name: sql<string>`${plan.name}`.as('name'),
							intervalDays: sql<number | null>`${plan.intervalDays}`.as(
								'intervalDays',
							),
							intervalSessions: sql<number | null>`${plan.intervalSessions}`.as(
								'intervalSessions',
							),
							intervalUnit: sql<string>`${plan.intervalUnit}`.as(
								'intervalUnit',
							),
							intervalValue: sql<number>`${plan.intervalValue}`.as(
								'intervalValue',
							),
							baselineAt: sql<string>`${plan.baselineAt}`.as('baselineAt'),
							baselineSessionCount:
								sql<number>`${plan.baselineSessionCount}`.as(
									'baselineSessionCount',
								),
							status: sql<string>`${plan.status}`.as('status'),
							pauseReason: sql<string | null>`${plan.pauseReason}`.as(
								'pauseReason',
							),
							pausedAt: sql<string | null>`${plan.pausedAt}`.as('pausedAt'),
						})
						.from(car)
						.where(selectParent),
				)
		: null;
	const recordMutation =
		record && change.entity === 'service'
			? current
				? database
						.update(serviceRecord)
						.set(record)
						.where(
							and(
								eq(serviceRecord.id, identity),
								eq(serviceRecord.carId, parent.id),
								witness,
							),
						)
				: database.insert(serviceRecord).select(
						database
							.select({
								id: sql<string>`${record.id}`.as('id'),
								carId: sql<string>`${record.carId}`.as('carId'),
								componentId: sql<string | null>`${record.componentId}`.as(
									'componentId',
								),
								planId: sql<string | null>`${record.planId}`.as('planId'),
								performedAt: sql<string>`${record.performedAt}`.as(
									'performedAt',
								),
								description: sql<string>`${record.description}`.as(
									'description',
								),
								notes: sql<string | null>`${record.notes}`.as('notes'),
								cost: sql<number | null>`${record.cost}`.as('cost'),
								currency: sql<string | null>`${record.currency}`.as('currency'),
								baselineAt: sql<string>`${record.baselineAt}`.as('baselineAt'),
								baselineSessionCount: sql<
									number | null
								>`${record.baselineSessionCount}`.as('baselineSessionCount'),
								previousBaselineAt: sql<
									string | null
								>`${record.previousBaselineAt}`.as('previousBaselineAt'),
								previousBaselineSessionCount: sql<
									number | null
								>`${record.previousBaselineSessionCount}`.as(
									'previousBaselineSessionCount',
								),
								deletedAt: sql<string | null>`${record.deletedAt}`.as(
									'deletedAt',
								),
							})
							.from(car)
							.where(selectParent),
					)
			: null;
	const planBase = change.entity === 'plan' ? change.base : change.planBase;
	const planColumns = getTableColumns(maintenancePlan);
	const recordColumns = getTableColumns(serviceRecord);
	const unchangedPlan = planBase
		? exists(
				database
					.select({ id: maintenancePlan.id })
					.from(maintenancePlan)
					.where(
						and(
							...Object.entries(planBase).map(
								([key, value]) =>
									sql`${planColumns[key as keyof typeof planColumns]} IS ${value}`,
							),
						),
					),
			)
		: undefined;
	const unchangedRecord =
		change.entity === 'service' && change.base
			? exists(
					database
						.select({ id: serviceRecord.id })
						.from(serviceRecord)
						.where(
							and(
								...Object.entries(change.base).map(
									([key, value]) =>
										sql`${recordColumns[key as keyof typeof recordColumns]} IS ${value}`,
								),
							),
						),
				)
			: undefined;

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
					unchangedPlan,
					unchangedRecord,
					isNull(car.archivedAt),
				),
			),
		...(planMutation ? [planMutation] : []),
		...(recordMutation ? [recordMutation] : []),
		database
			.update(syncOperation)
			.set({
				outcome: 'applied',
				httpStatus: 200,
				responseJson: JSON.stringify({
					operationId,
					outcome: 'applied',
					collection: { ...next, version },
				}),
				completedAt: now,
			})
			.where(and(pending, witness)),
	]);
	if (batch[0].meta.changes === 0) {
		const latest = await ownedCar(c, parent.id);
		if (!latest) return reject('Car not found', 404);
		return conflict(await read(latest.version));
	}
	return requireTerminalReceipt();
};
