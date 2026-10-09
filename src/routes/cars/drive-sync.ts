import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { driveSyncCommandInput } from '../../drive-sync-contract';
import { car, driveSession, syncOperation } from '../../schema';
import type { AppContext } from '../../types';
import { ownedCar } from './car-records';

type DriveSyncContext = Readonly<{
	command: Readonly<{ type: string; carId: string }>;
	operationId: string;
	requestHash: string;
	now: string;
	requireTerminalReceipt: () => Promise<Response>;
}>;

/**
 * Applies an owner's durable Drive command inside Car sync admission. Compares
 * the saved base and uses one conditional database batch for record changes and
 * the operation receipt. Car-version and pending-receipt witnesses prevent a
 * concurrent edit or in-flight duplicate from repeating child writes.
 */
export const applyDriveSyncOperation = async (
	c: AppContext,
	context: DriveSyncContext,
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
	const parsed = driveSyncCommandInput.safeParse(command);
	if (!parsed.success)
		return reject(
			'DRIVE_VALIDATION_FAILED',
			'Drive change needs attention',
			422,
			parsed.error.flatten(),
		);
	const change = parsed.data;
	const parent = await ownedCar(c, change.carId);
	if (!parent) return reject('CAR_NOT_FOUND', 'Car not found', 404);
	if (parent.archivedAt !== null)
		return reject(
			'CAR_ARCHIVED',
			'Restore this car before changing its drive',
			409,
		);

	if (
		(change.base &&
			(change.base.carId !== parent.id ||
				change.base.id !== change.sessionId ||
				change.base.deletedAt)) ||
		(change.action === 'archive' && !change.base)
	)
		return reject(
			'DRIVE_VALIDATION_FAILED',
			'Drive session identity does not match the change',
			422,
		);
	const sessions = await database
		.select()
		.from(driveSession)
		.where(eq(driveSession.carId, parent.id));
	const current =
		sessions.find((value) => value.id === change.sessionId) ?? null;
	const collection = { carId: parent.id, version: parent.version, sessions };
	const conflict = (remote: typeof collection) =>
		complete(
			{
				operationId,
				outcome: 'conflict',
				error: {
					code: 'DRIVE_CONFLICT',
					message:
						'This Drive session changed after the local work was saved. Both versions have been retained.',
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
	if (!current) {
		const collision = await database
			.select({ id: driveSession.id })
			.from(driveSession)
			.where(eq(driveSession.id, change.sessionId))
			.get();
		if (collision)
			return reject(
				'DRIVE_ID_UNAVAILABLE',
				'The Drive session identity is unavailable',
				409,
			);
	}
	const changed = {
		id: change.sessionId,
		carId: parent.id,
		...change.input,
		deletedAt: change.action === 'archive' ? now : null,
	};
	const nextSessions = current
		? sessions.map((value) => (value.id === changed.id ? changed : value))
		: [...sessions, changed];
	const version = parent.version + 1;
	const response = {
		operationId,
		outcome: 'applied',
		collection: { carId: parent.id, version, sessions: nextSessions },
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
	const mutation = current
		? database
				.update(driveSession)
				.set(changed)
				.where(
					and(
						eq(driveSession.id, current.id),
						eq(driveSession.carId, parent.id),
						witness,
					),
				)
		: database.insert(driveSession).select(
				database
					.select({
						id: sql<string>`${changed.id}`.as('id'),
						carId: sql<string>`${parent.id}`.as('carId'),
						startedAt: sql<string>`${changed.startedAt}`.as('startedAt'),
						durationMinutes: sql<number | null>`${changed.durationMinutes}`.as(
							'durationMinutes',
						),
						conditions: sql<string | null>`${changed.conditions}`.as(
							'conditions',
						),
						notes: sql<string | null>`${changed.notes}`.as('notes'),
						deletedAt: sql<string | null>`${changed.deletedAt}`.as('deletedAt'),
					})
					.from(car)
					.where(and(eq(car.id, parent.id), witness)),
			);
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
		mutation,
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
		const latestSessions = await database
			.select()
			.from(driveSession)
			.where(eq(driveSession.carId, parent.id));
		return conflict({
			carId: parent.id,
			version: latest.version,
			sessions: latestSessions,
		});
	}
	return requireTerminalReceipt();
};
