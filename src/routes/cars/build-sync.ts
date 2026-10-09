import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { buildSyncCommandInput } from '../../build-sync-contract';
import { db } from '../../db';
import { car, component, maintenancePlan, syncOperation } from '../../schema';
import type { AppContext } from '../../types';
import { required } from '../invariant';
import { planSessionCount } from '../maintenance/plan-records';
import { pendingSyncReceipt } from '../pending-sync-receipt';
import { ownedCar, parseComponentSlot, publicComponent } from './car-records';

type BuildSyncContext = Readonly<{
	command: Readonly<{ type: string; carId: string }>;
	operationId: string;
	requestHash: string;
	now: string;
	requireTerminalReceipt: () => Promise<Response>;
}>;

/**
 * Applies an owner's durable Component command inside Car sync admission. Compares
 * the saved base and uses one conditional database batch for record changes and
 * the operation receipt. Car-version and pending-receipt witnesses prevent a
 * concurrent edit or in-flight duplicate from repeating child writes.
 */
export const applyBuildSyncOperation = async (
	c: AppContext,
	context: BuildSyncContext,
): Promise<Response> => {
	const { command, operationId, requestHash, now, requireTerminalReceipt } =
		context;
	const database = db(c.env);
	const ownerId = c.get('userId');
	const receiptPending = pendingSyncReceipt(
		database,
		ownerId,
		operationId,
		requestHash,
	);
	const receiptWhere = and(
		eq(syncOperation.ownerId, ownerId),
		eq(syncOperation.operationId, operationId),
		eq(syncOperation.requestHash, requestHash),
		eq(syncOperation.outcome, 'pending'),
	);
	const complete = async (
		response: Readonly<Record<string, unknown>>,
		status: 200 | 404 | 409 | 422,
	) => {
		await database
			.update(syncOperation)
			.set({
				outcome: String(response['outcome']),
				httpStatus: status,
				responseJson: JSON.stringify(response),
				completedAt: now,
			})
			.where(receiptWhere)
			.run();
		return requireTerminalReceipt();
	};
	const reject = (
		code: string,
		message: string,
		status: 404 | 409 | 422,
		details?: unknown,
	) =>
		complete(
			{
				operationId,
				outcome: 'rejected',
				error: { code, message, ...(details === undefined ? {} : { details }) },
			},
			status,
		);
	const parsed = buildSyncCommandInput.safeParse(command);
	if (!parsed.success)
		return reject(
			'BUILD_VALIDATION_FAILED',
			'Build change needs attention',
			422,
			parsed.error.flatten(),
		);
	const change = parsed.data;
	const parent = await ownedCar(c, change.carId);
	if (!parent) return reject('CAR_NOT_FOUND', 'Car not found', 404);
	if (parent.archivedAt !== null)
		return reject(
			'CAR_ARCHIVED',
			'Restore this car before changing its build',
			409,
		);
	const slot = parseComponentSlot(change.input.slot, change.input.slotType);
	if (
		!slot ||
		(change.base &&
			(change.base.carId !== parent.id || change.base.slot !== slot.slot)) ||
		(change.action !== 'install' && !change.base) ||
		((change.action === 'edit' || change.action === 'remove') &&
			change.componentId !== change.base?.id)
	)
		return reject(
			'BUILD_VALIDATION_FAILED',
			'Component and slot identity do not match the change',
			422,
		);
	const components = await database
		.select()
		.from(component)
		.where(eq(component.carId, parent.id));
	const current =
		components.find(
			(value) => value.slot === slot.slot && value.removedAt === null,
		) ?? null;
	const collection = {
		carId: parent.id,
		version: parent.version,
		components: components.map(publicComponent),
	};
	const conflict = (remote: typeof collection) =>
		complete(
			{
				operationId,
				outcome: 'conflict',
				error: {
					code: 'BUILD_CONFLICT',
					message:
						'This Component changed after the local work was saved. Both versions have been retained.',
				},
				remote,
			},
			409,
		);
	const base = change.base;
	const matches =
		current === null
			? base === null
			: base !== null &&
				Object.entries(base).every(
					([field, value]) => current[field as keyof typeof current] === value,
				);
	if (!matches) return conflict(collection);
	const inserts = change.action === 'install' || change.action === 'replace';
	if (inserts) {
		const collision = await database
			.select({ id: component.id })
			.from(component)
			.where(eq(component.id, change.componentId))
			.get();
		if (collision)
			return reject(
				'COMPONENT_ID_UNAVAILABLE',
				'The Component identity is unavailable',
				409,
			);
	}
	const version = parent.version + 1;
	const value = change.input;
	const changed =
		change.action === 'remove'
			? { ...(current as typeof component.$inferSelect), removedAt: now }
			: {
					id: change.componentId,
					carId: parent.id,
					slot: slot.slot,
					slotType: slot.slotType,
					name: value.name,
					manufacturer: value.manufacturer ?? null,
					model: value.model ?? null,
					serialNumber: value.serialNumber ?? null,
					notes: value.notes ?? null,
					installedAt:
						value.installedAt ??
						(inserts
							? now
							: required(current, 'Current Component was not resolved')
									.installedAt),
					removedAt: null,
				};
	const nextComponents = components.map((value) =>
		value.id !== current?.id
			? value
			: inserts
				? { ...value, removedAt: now }
				: changed,
	);
	if (inserts) nextComponents.push(changed);
	const response = {
		operationId,
		outcome: 'applied',
		collection: {
			carId: parent.id,
			version,
			components: nextComponents.map(publicComponent),
		},
	};
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
	const sessionCount =
		inserts && current ? await planSessionCount(c, parent.id) : 0;
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
				),
			),
		...(current
			? [
					database
						.update(component)
						.set(
							inserts || change.action === 'remove'
								? { removedAt: now }
								: changed,
						)
						.where(
							and(
								eq(component.id, current.id),
								eq(component.carId, parent.id),
								witness,
							),
						),
				]
			: []),
		...(inserts
			? [
					database.insert(component).select(
						database
							.select({
								id: sql<string>`${changed.id}`.as('id'),
								carId: sql<string>`${parent.id}`.as('carId'),
								slot: sql<string>`${changed.slot}`.as('slot'),
								slotType: sql<string>`${changed.slotType}`.as('slotType'),
								name: sql<string>`${changed.name}`.as('name'),
								manufacturer: sql<string | null>`${changed.manufacturer}`.as(
									'manufacturer',
								),
								model: sql<string | null>`${changed.model}`.as('model'),
								serialNumber: sql<string | null>`${changed.serialNumber}`.as(
									'serialNumber',
								),
								notes: sql<string | null>`${changed.notes}`.as('notes'),
								installedAt: sql<string>`${changed.installedAt}`.as(
									'installedAt',
								),
								removedAt: sql<null>`null`.as('removedAt'),
							})
							.from(car)
							.where(and(eq(car.id, parent.id), witness)),
					),
				]
			: []),
		...(current && (inserts || change.action === 'remove')
			? [
					database
						.update(maintenancePlan)
						.set(
							inserts
								? {
										componentId: changed.id,
										baselineAt: changed.installedAt,
										baselineSessionCount: sessionCount,
										status: 'active',
										pauseReason: null,
										pausedAt: null,
									}
								: { status: 'paused', pauseReason: 'component', pausedAt: now },
						)
						.where(
							and(
								eq(maintenancePlan.componentId, current.id),
								inserts
									? sql`(${maintenancePlan.status} = 'active' or ${maintenancePlan.pauseReason} = 'component')`
									: eq(maintenancePlan.status, 'active'),
								witness,
							),
						),
				]
			: []),
		database
			.update(syncOperation)
			.set({
				outcome: 'applied',
				httpStatus: 200,
				responseJson: JSON.stringify(response),
				completedAt: now,
			})
			.where(and(receiptWhere, witness)),
	]);
	if (batch[0].meta.changes === 0) {
		const latest = await ownedCar(c, parent.id);
		if (!latest) return reject('CAR_NOT_FOUND', 'Car not found', 404);
		const latestComponents = await database
			.select()
			.from(component)
			.where(eq(component.carId, parent.id));
		return conflict({
			carId: parent.id,
			version: latest.version,
			components: latestComponents,
		});
	}
	return requireTerminalReceipt();
};
