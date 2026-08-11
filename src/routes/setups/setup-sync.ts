import { and, eq, exists, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { car, setup, syncOperation } from '../../schema';
import { canWriteSetup } from '../../setup-policy';
import {
	type AppContext,
	setupCorrectSyncCommandInput,
	setupCreateSyncCommandInput,
	setupSelectCurrentSyncCommandInput,
	setupUpdateInput,
} from '../../types';
import { ownedCar } from '../cars/car-records';
import { jsonText } from '../json-values';
import {
	publicSetup,
	setupCopyValue,
	setupInsertValues,
} from './setup-records';

type SetupSyncContext = Readonly<{
	command: Readonly<{ type: string; carId: string }>;
	operationId: string;
	requestHash: string;
	now: string;
	requireTerminalReceipt: () => Promise<Response>;
}>;

const canonicalJson = (value: unknown): string => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
};

const sameValue = (left: unknown, right: unknown): boolean =>
	canonicalJson(left ?? null) === canonicalJson(right ?? null);

const currentSelectionMatches = (
	value: typeof car.$inferSelect,
	base: Readonly<{ setupId?: string | null; version: number }>,
): boolean =>
	value.currentSetupId === (base.setupId ?? null) &&
	value.currentSetupVersion === base.version;

const currentSelectionWhere = (
	base: Readonly<{ setupId?: string | null; version: number }>,
) =>
	and(
		base.setupId == null
			? isNull(car.currentSetupId)
			: eq(car.currentSetupId, base.setupId),
		eq(car.currentSetupVersion, base.version),
	);

const currentSetup = async (
	c: AppContext,
	parentCar: typeof car.$inferSelect,
) => {
	if (!parentCar.currentSetupId) return undefined;
	return db(c.env)
		.select()
		.from(setup)
		.where(
			and(
				eq(setup.id, parentCar.currentSetupId),
				eq(setup.carId, parentCar.id),
			),
		)
		.get();
};

const setupFieldValue = (
	value: typeof setup.$inferSelect,
	field: string,
): unknown => {
	const editable = setupCopyValue(value) as Readonly<Record<string, unknown>>;
	return editable[field] ?? null;
};

const setupUpdateValues = (
	value: ReturnType<typeof setupUpdateInput.parse>,
	now: string,
	version: number,
	operationId: string,
) => ({
	name: value.name,
	status: value.status,
	setupDate:
		value.setupDate === undefined
			? undefined
			: value.setupDate === null
				? null
				: new Date(value.setupDate).toISOString(),
	track: value.track,
	event: value.event,
	surface: value.surface,
	traction: value.traction,
	moisture: value.moisture,
	condition: value.condition,
	temperature: value.temperature,
	vehicle: jsonText(value.vehicle),
	drivetrain: jsonText(value.drivetrain),
	electronics: jsonText(value.electronics),
	tires: jsonText(value.tires),
	shocks: jsonText(value.shocks),
	frontSuspension: jsonText(value.frontSuspension),
	rearSuspension: jsonText(value.rearSuspension),
	notes: value.notes,
	sourceUrl: value.sourceUrl,
	sourcePdfReference: value.sourcePdfReference,
	sourceMetadata: jsonText(value.sourceMetadata),
	rawValues: jsonText(value.rawValues),
	unmappedValues: jsonText(value.unmappedValues),
	updatedAt: now,
	version,
	lastOperationId: operationId,
});

export const applySetupSyncOperation = async (
	c: AppContext,
	context: SetupSyncContext,
): Promise<Response> => {
	const { command, operationId, requestHash, now, requireTerminalReceipt } =
		context;
	const database = db(c.env);
	const ownerId = c.get('userId');
	const complete = async (
		response: Readonly<Record<string, unknown>>,
		status: 200 | 404 | 409 | 422,
	): Promise<Response> => {
		await database
			.update(syncOperation)
			.set({
				outcome: String(response['outcome']),
				httpStatus: status,
				responseJson: JSON.stringify(response),
				completedAt: now,
			})
			.where(
				and(
					eq(syncOperation.ownerId, ownerId),
					eq(syncOperation.operationId, operationId),
					eq(syncOperation.requestHash, requestHash),
					eq(syncOperation.outcome, 'pending'),
				),
			)
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
	const conflict = async (
		parentCar: typeof car.$inferSelect,
		message: string,
		setupValue: typeof setup.$inferSelect | null = null,
	) => {
		const remoteCurrent = await currentSetup(c, parentCar);
		return complete(
			{
				operationId,
				outcome: 'conflict',
				error: { code: 'SETUP_VERSION_CONFLICT', message },
				remote: {
					currentSetupId: parentCar.currentSetupId,
					currentSetupVersion: parentCar.currentSetupVersion,
					setup: setupValue
						? publicSetup(
								setupValue,
								setupValue.id === parentCar.currentSetupId,
							)
						: remoteCurrent
							? publicSetup(remoteCurrent, true)
							: null,
				},
			},
			409,
		);
	};

	const parentCar = await ownedCar(c, command.carId);
	if (!parentCar) return reject('CAR_NOT_FOUND', 'Car not found', 404);
	if (!canWriteSetup(parentCar))
		return reject(
			'CAR_ARCHIVED',
			'Restore this car before changing its setup',
			409,
		);

	if (command.type === 'setup.create') {
		const parsed = setupCreateSyncCommandInput.safeParse(command);
		if (!parsed.success)
			return reject(
				'SETUP_VALIDATION_FAILED',
				'Setup change needs attention',
				422,
				parsed.error.flatten(),
			);
		const create = parsed.data;
		if (create.makeCurrent && !create.baseCurrent)
			return reject(
				'SETUP_VALIDATION_FAILED',
				'Setup change needs attention',
				422,
				{ baseCurrent: ['Current setup base is required'] },
			);
		if (!create.makeCurrent && create.baseCurrent)
			return reject(
				'SETUP_VALIDATION_FAILED',
				'Setup change needs attention',
				422,
				{ baseCurrent: ['Current setup base is not allowed'] },
			);
		const existing = await database
			.select()
			.from(setup)
			.where(eq(setup.id, create.setupId))
			.get();
		if (existing) {
			if (
				existing.carId !== create.carId ||
				existing.lastOperationId !== operationId
			)
				return conflict(
					parentCar,
					'The Setup identity is already in use',
					existing.carId === create.carId ? existing : null,
				);
			if (
				create.makeCurrent &&
				parentCar.currentSetupOperationId !== operationId
			)
				return conflict(
					parentCar,
					'The Current setup changed after this operation was queued',
					existing,
				);
			return complete(
				{
					operationId,
					outcome: 'applied',
					setup: publicSetup(
						existing,
						existing.id === parentCar.currentSetupId,
					),
					currentSetupId: parentCar.currentSetupId,
					currentSetupVersion: parentCar.currentSetupVersion,
				},
				200,
			);
		}
		if (
			create.makeCurrent &&
			create.baseCurrent &&
			!currentSelectionMatches(parentCar, create.baseCurrent)
		)
			return conflict(
				parentCar,
				'The Current setup changed after this operation was queued',
			);
		if (create.copiedFromSetupId) {
			const source = await database
				.select()
				.from(setup)
				.where(
					and(
						eq(setup.id, create.copiedFromSetupId),
						eq(setup.carId, create.carId),
					),
				)
				.get();
			if (!source)
				return reject('SETUP_NOT_FOUND', 'Source setup not found', 404);
		}
		const inserted = setupInsertValues(
			create.setupId,
			create.carId,
			create.setup,
			now,
			create.copiedFromSetupId,
			operationId,
		);
		const currentSetupId = create.makeCurrent
			? create.setupId
			: parentCar.currentSetupId;
		const currentSetupVersion = create.makeCurrent
			? parentCar.currentSetupVersion + 1
			: parentCar.currentSetupVersion;
		const response = {
			operationId,
			outcome: 'applied',
			setup: publicSetup(inserted, create.makeCurrent),
			currentSetupId,
			currentSetupVersion,
		};
		const setupWitness = exists(
			database
				.select({ id: setup.id })
				.from(setup)
				.where(
					and(
						eq(setup.id, create.setupId),
						eq(setup.carId, create.carId),
						eq(setup.lastOperationId, operationId),
					),
				),
		);
		const selectionWitness = create.makeCurrent
			? exists(
					database
						.select({ id: car.id })
						.from(car)
						.where(
							and(
								eq(car.id, create.carId),
								eq(car.ownerId, ownerId),
								eq(car.currentSetupOperationId, operationId),
							),
						),
				)
			: undefined;
		await database.batch([
			database.insert(setup).values(inserted),
			...(create.makeCurrent && create.baseCurrent
				? [
						database
							.update(car)
							.set({
								currentSetupId: create.setupId,
								currentSetupVersion,
								currentSetupOperationId: operationId,
							})
							.where(
								and(
									eq(car.id, create.carId),
									eq(car.ownerId, ownerId),
									currentSelectionWhere(create.baseCurrent),
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
				.where(
					and(
						eq(syncOperation.ownerId, ownerId),
						eq(syncOperation.operationId, operationId),
						eq(syncOperation.requestHash, requestHash),
						eq(syncOperation.outcome, 'pending'),
						setupWitness,
						...(selectionWitness ? [selectionWitness] : []),
					),
				),
		]);
		return requireTerminalReceipt();
	}

	if (command.type === 'setup.correct') {
		const parsed = setupCorrectSyncCommandInput.safeParse(command);
		if (!parsed.success)
			return reject(
				'SETUP_VALIDATION_FAILED',
				'Setup correction needs attention',
				422,
				parsed.error.flatten(),
			);
		const correction = parsed.data;
		const changes = setupUpdateInput.safeParse(correction.changes);
		const changeFields = Object.keys(correction.changes).sort();
		const baseFields = Object.keys(correction.base).sort();
		if (
			!changes.success ||
			changeFields.length !== baseFields.length ||
			changeFields.some((field, index) => field !== baseFields[index]) ||
			(changes.success &&
				Object.keys(changes.data).length !== changeFields.length)
		)
			return reject(
				'SETUP_VALIDATION_FAILED',
				'Setup correction needs attention',
				422,
				changes.success
					? { base: ['Base must match changed fields'] }
					: changes.error.flatten(),
			);
		const existing = await database
			.select()
			.from(setup)
			.where(
				and(
					eq(setup.id, correction.setupId),
					eq(setup.carId, correction.carId),
				),
			)
			.get();
		if (!existing) return reject('SETUP_NOT_FOUND', 'Setup not found', 404);
		if (
			changeFields.some(
				(field) =>
					!sameValue(setupFieldValue(existing, field), correction.base[field]),
			)
		)
			return conflict(
				parentCar,
				'The Setup changed in the same fields after this correction was queued',
				existing,
			);
		const version = existing.version + 1;
		const updates = setupUpdateValues(changes.data, now, version, operationId);
		const updated = { ...existing, ...updates };
		const response = {
			operationId,
			outcome: 'applied',
			setup: publicSetup(updated, updated.id === parentCar.currentSetupId),
			currentSetupId: parentCar.currentSetupId,
			currentSetupVersion: parentCar.currentSetupVersion,
		};
		await database.batch([
			database
				.update(setup)
				.set(updates)
				.where(
					and(
						eq(setup.id, existing.id),
						eq(setup.carId, parentCar.id),
						eq(setup.version, existing.version),
					),
				),
			database
				.update(syncOperation)
				.set({
					outcome: 'applied',
					httpStatus: 200,
					responseJson: JSON.stringify(response),
					completedAt: now,
				})
				.where(
					and(
						eq(syncOperation.ownerId, ownerId),
						eq(syncOperation.operationId, operationId),
						eq(syncOperation.requestHash, requestHash),
						eq(syncOperation.outcome, 'pending'),
						exists(
							database
								.select({ id: setup.id })
								.from(setup)
								.where(
									and(
										eq(setup.id, existing.id),
										eq(setup.lastOperationId, operationId),
									),
								),
						),
					),
				),
		]);
		return requireTerminalReceipt();
	}

	const parsed = setupSelectCurrentSyncCommandInput.safeParse(command);
	if (!parsed.success)
		return reject(
			'SETUP_VALIDATION_FAILED',
			'Current setup selection needs attention',
			422,
			parsed.error.flatten(),
		);
	const selection = parsed.data;
	const selected = await database
		.select()
		.from(setup)
		.where(
			and(eq(setup.id, selection.setupId), eq(setup.carId, selection.carId)),
		)
		.get();
	if (!selected) return reject('SETUP_NOT_FOUND', 'Setup not found', 404);
	if (parentCar.currentSetupId === selected.id) {
		return complete(
			{
				operationId,
				outcome: 'applied',
				setup: publicSetup(selected, true),
				currentSetupId: selected.id,
				currentSetupVersion: parentCar.currentSetupVersion,
			},
			200,
		);
	}
	if (!currentSelectionMatches(parentCar, selection.baseCurrent))
		return conflict(
			parentCar,
			'The Current setup changed after this selection was queued',
		);
	const currentSetupVersion = parentCar.currentSetupVersion + 1;
	const response = {
		operationId,
		outcome: 'applied',
		setup: publicSetup(selected, true),
		currentSetupId: selected.id,
		currentSetupVersion,
	};
	await database.batch([
		database
			.update(car)
			.set({
				currentSetupId: selected.id,
				currentSetupVersion,
				currentSetupOperationId: operationId,
			})
			.where(
				and(
					eq(car.id, parentCar.id),
					eq(car.ownerId, ownerId),
					currentSelectionWhere(selection.baseCurrent),
				),
			),
		database
			.update(syncOperation)
			.set({
				outcome: 'applied',
				httpStatus: 200,
				responseJson: JSON.stringify(response),
				completedAt: now,
			})
			.where(
				and(
					eq(syncOperation.ownerId, ownerId),
					eq(syncOperation.operationId, operationId),
					eq(syncOperation.requestHash, requestHash),
					eq(syncOperation.outcome, 'pending'),
					exists(
						database
							.select({ id: car.id })
							.from(car)
							.where(
								and(
									eq(car.id, parentCar.id),
									eq(car.ownerId, ownerId),
									eq(car.currentSetupOperationId, operationId),
								),
							),
					),
				),
			),
	]);
	return requireTerminalReceipt();
};
