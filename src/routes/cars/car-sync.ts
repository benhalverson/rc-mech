import { and, eq, exists, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../../db';
import { car, maintenancePlan, syncOperation } from '../../schema';
import {
	type AppEnv,
	carEditSyncCommandInput,
	carInput,
	carLifecycleSyncCommandInput,
	carSyncEnvelopeInput,
	carSyncOperationId,
	carUpdateInput,
} from '../../types';
import { ownedCar, publicCar } from './car-records';

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

const requestDigest = async (value: unknown): Promise<string> => {
	const bytes = new TextEncoder().encode(canonicalJson(value));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
};

const storedReceiptResponse = (
	receipt: typeof syncOperation.$inferSelect | undefined,
): Response | undefined => {
	if (!receipt || receipt.outcome === 'pending') return undefined;
	if (receipt.httpStatus === null || receipt.responseJson === null)
		throw new Error('Terminal sync receipt is incomplete');
	return new Response(receipt.responseJson, {
		status: receipt.httpStatus,
		headers: { 'content-type': 'application/json; charset=UTF-8' },
	});
};

export const createCarSyncRoutes = () => {
	const routes = new Hono<AppEnv>();
	routes.onError((error, c) => {
		console.error(
			JSON.stringify({
				message: 'Car synchronization request failed',
				error: String(error),
			}),
		);
		return c.json(
			{
				error: {
					code: 'SYNC_TEMPORARILY_UNAVAILABLE',
					message: 'Car synchronization is temporarily unavailable',
				},
			},
			503,
		);
	});

	routes.put('/sync/operations/:operationId', async (c) => {
		const operationId = carSyncOperationId.safeParse(
			c.req.param('operationId'),
		);
		if (!operationId.success)
			return c.json(
				{
					error: { code: 'INVALID_OPERATION', message: 'Invalid operation ID' },
				},
				400,
			);

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json(
				{ error: { code: 'INVALID_OPERATION', message: 'Invalid JSON body' } },
				400,
			);
		}
		const parsed = carSyncEnvelopeInput.safeParse(body);
		if (!parsed.success)
			return c.json(
				{ error: { code: 'INVALID_OPERATION', message: 'Invalid operation' } },
				400,
			);

		const ownerId = c.get('userId');
		const command = parsed.data.command;
		const now = new Date().toISOString();
		const database = db(c.env);
		const requestHash = await requestDigest(parsed.data);
		const readReceipt = () =>
			database
				.select()
				.from(syncOperation)
				.where(
					and(
						eq(syncOperation.ownerId, ownerId),
						eq(syncOperation.operationId, operationId.data),
					),
				)
				.get();
		const requireTerminalReceipt = async () => {
			const completed = storedReceiptResponse(await readReceipt());
			if (!completed)
				throw new Error('Car operation did not produce a terminal receipt');
			return completed;
		};
		const claimed = await database
			.insert(syncOperation)
			.values({
				ownerId,
				operationId: operationId.data,
				contractVersion: parsed.data.contractVersion,
				kind: command.type,
				entityType: 'car',
				entityId: command.carId,
				requestHash,
				outcome: 'pending',
				createdAt: now,
			})
			.onConflictDoNothing()
			.returning()
			.get();
		const receipt = claimed ?? (await readReceipt());
		if (!receipt)
			return c.json(
				{
					error: {
						code: 'OPERATION_IN_PROGRESS',
						message: 'Operation is already being applied',
					},
				},
				503,
			);
		if (receipt.requestHash !== requestHash)
			return c.json(
				{
					error: {
						code: 'OPERATION_ID_REUSED',
						message: 'Operation ID was already used for another request',
					},
				},
				409,
			);
		const replay = storedReceiptResponse(receipt);
		if (replay) return replay;
		if (parsed.data.contractVersion !== 1) {
			const response = {
				operationId: operationId.data,
				outcome: 'rejected' as const,
				error: {
					code: 'OPERATION_CONTRACT_UNSUPPORTED',
					message: 'Operation contract version is not supported',
					details: {
						supported: [1],
						received: parsed.data.contractVersion,
					},
				},
			};
			await database
				.update(syncOperation)
				.set({
					outcome: 'rejected',
					httpStatus: 409,
					responseJson: JSON.stringify(response),
					completedAt: now,
				})
				.where(
					and(
						eq(syncOperation.ownerId, ownerId),
						eq(syncOperation.operationId, operationId.data),
						eq(syncOperation.requestHash, requestHash),
						eq(syncOperation.outcome, 'pending'),
					),
				)
				.run();
			return c.json(response, 409);
		}
		const rejectValidation = async (details: unknown) => {
			const response = {
				operationId: operationId.data,
				outcome: 'rejected' as const,
				error: {
					code: 'CAR_VALIDATION_FAILED',
					message: 'Car change needs attention',
					details,
				},
			};
			await database
				.update(syncOperation)
				.set({
					outcome: 'rejected',
					httpStatus: 422,
					responseJson: JSON.stringify(response),
					completedAt: now,
				})
				.where(
					and(
						eq(syncOperation.ownerId, ownerId),
						eq(syncOperation.operationId, operationId.data),
						eq(syncOperation.requestHash, requestHash),
						eq(syncOperation.outcome, 'pending'),
					),
				)
				.run();
			return c.json(response, 422);
		};
		const rejectNotFound = async () => {
			const response = {
				operationId: operationId.data,
				outcome: 'rejected' as const,
				error: { code: 'CAR_NOT_FOUND', message: 'Car not found' },
			};
			await database
				.update(syncOperation)
				.set({
					outcome: 'rejected',
					httpStatus: 404,
					responseJson: JSON.stringify(response),
					completedAt: now,
				})
				.where(
					and(
						eq(syncOperation.ownerId, ownerId),
						eq(syncOperation.operationId, operationId.data),
						eq(syncOperation.requestHash, requestHash),
						eq(syncOperation.outcome, 'pending'),
					),
				)
				.run();
			return c.json(response, 404);
		};

		if (command.type === 'car.edit') {
			const editCommand = carEditSyncCommandInput.safeParse(command);
			if (!editCommand.success) {
				const changes = carUpdateInput.safeParse(command.changes);
				return rejectValidation(
					changes.success
						? editCommand.error.flatten()
						: changes.error.flatten(),
				);
			}
			const edit = editCommand.data;
			const changedFieldNames = Object.keys(edit.changes).sort();
			const baseFieldNames = Object.keys(edit.base).sort();
			if (
				changedFieldNames.length !== baseFieldNames.length ||
				changedFieldNames.some(
					(field, index) => field !== baseFieldNames[index],
				)
			)
				return rejectValidation({
					formErrors: [],
					fieldErrors: {
						base: [
							'Base values must be provided for exactly the changed fields',
						],
					},
				});
			const existing = await ownedCar(c, edit.carId);
			if (!existing) return rejectNotFound();
			const changedFields = Object.keys(edit.changes) as Array<
				keyof typeof edit.changes
			>;
			if (changedFields.some((field) => existing[field] !== edit.base[field])) {
				const response = {
					operationId: operationId.data,
					outcome: 'conflict' as const,
					error: {
						code: 'CAR_VERSION_CONFLICT',
						message: 'The Car changed after this operation was queued',
					},
					local: { baseVersion: edit.baseVersion, command: edit },
					remote: { car: publicCar(existing) },
				};
				await database
					.update(syncOperation)
					.set({
						outcome: 'conflict',
						httpStatus: 409,
						responseJson: JSON.stringify(response),
						completedAt: now,
					})
					.where(
						and(
							eq(syncOperation.ownerId, ownerId),
							eq(syncOperation.operationId, operationId.data),
							eq(syncOperation.requestHash, requestHash),
							eq(syncOperation.outcome, 'pending'),
						),
					)
					.run();
				return requireTerminalReceipt();
			}
			const updatedCar = publicCar({
				...existing,
				...edit.changes,
				version: existing.version + 1,
				lastOperationId: operationId.data,
			});
			const response = {
				operationId: operationId.data,
				outcome: 'applied' as const,
				car: updatedCar,
			};
			await database.batch([
				database
					.update(car)
					.set({
						...edit.changes,
						version: existing.version + 1,
						lastOperationId: operationId.data,
					})
					.where(
						and(
							eq(car.id, existing.id),
							eq(car.ownerId, ownerId),
							eq(car.version, existing.version),
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
							eq(syncOperation.operationId, operationId.data),
							eq(syncOperation.requestHash, requestHash),
							eq(syncOperation.outcome, 'pending'),
							exists(
								database
									.select({ id: car.id })
									.from(car)
									.where(
										and(
											eq(car.id, existing.id),
											eq(car.ownerId, ownerId),
											eq(car.lastOperationId, operationId.data),
										),
									),
							),
						),
					),
			]);
			return requireTerminalReceipt();
		}

		if (command.type === 'car.archive' || command.type === 'car.restore') {
			const lifecycleCommand = carLifecycleSyncCommandInput.safeParse(command);
			if (!lifecycleCommand.success)
				return rejectValidation(lifecycleCommand.error.flatten());
			const lifecycle = lifecycleCommand.data;
			const existing = await ownedCar(c, lifecycle.carId);
			if (!existing) return rejectNotFound();
			const desiredStateAlreadyExists =
				lifecycle.type === 'car.archive'
					? existing.archivedAt !== null
					: existing.archivedAt === null;
			if (desiredStateAlreadyExists) {
				const response = {
					operationId: operationId.data,
					outcome: 'applied' as const,
					car: publicCar(existing),
				};
				await database
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
							eq(syncOperation.operationId, operationId.data),
							eq(syncOperation.requestHash, requestHash),
							eq(syncOperation.outcome, 'pending'),
						),
					)
					.run();
				return requireTerminalReceipt();
			}
			if (existing.archivedAt !== lifecycle.base.archivedAt) {
				const response = {
					operationId: operationId.data,
					outcome: 'conflict' as const,
					error: {
						code: 'CAR_VERSION_CONFLICT',
						message: 'The Car changed after this operation was queued',
					},
					local: {
						baseVersion: lifecycle.baseVersion,
						command: lifecycle,
					},
					remote: { car: publicCar(existing) },
				};
				await database
					.update(syncOperation)
					.set({
						outcome: 'conflict',
						httpStatus: 409,
						responseJson: JSON.stringify(response),
						completedAt: now,
					})
					.where(
						and(
							eq(syncOperation.ownerId, ownerId),
							eq(syncOperation.operationId, operationId.data),
							eq(syncOperation.requestHash, requestHash),
							eq(syncOperation.outcome, 'pending'),
						),
					)
					.run();
				return requireTerminalReceipt();
			}
			const archivedAt = lifecycle.type === 'car.archive' ? now : null;
			const lifecycleBase =
				lifecycle.type === 'car.archive'
					? isNull(car.archivedAt)
					: eq(car.archivedAt, lifecycle.base.archivedAt);
			const updatedCar = publicCar({
				...existing,
				archivedAt,
				version: existing.version + 1,
				lastOperationId: operationId.data,
			});
			const response = {
				operationId: operationId.data,
				outcome: 'applied' as const,
				car: updatedCar,
			};
			const operationWitness = () =>
				exists(
					database
						.select({ id: car.id })
						.from(car)
						.where(
							and(
								eq(car.id, existing.id),
								eq(car.ownerId, ownerId),
								eq(car.lastOperationId, operationId.data),
							),
						),
				);
			const maintenanceUpdate =
				lifecycle.type === 'car.archive'
					? database
							.update(maintenancePlan)
							.set({
								status: 'paused',
								pauseReason: 'car',
								pausedAt: now,
							})
							.where(
								and(
									eq(maintenancePlan.carId, existing.id),
									eq(maintenancePlan.status, 'active'),
									operationWitness(),
								),
							)
					: database
							.update(maintenancePlan)
							.set({ status: 'active', pauseReason: null, pausedAt: null })
							.where(
								and(
									eq(maintenancePlan.carId, existing.id),
									eq(maintenancePlan.status, 'paused'),
									eq(maintenancePlan.pauseReason, 'car'),
									operationWitness(),
								),
							);
			await database.batch([
				database
					.update(car)
					.set({
						archivedAt,
						version: existing.version + 1,
						lastOperationId: operationId.data,
					})
					.where(
						and(
							eq(car.id, existing.id),
							eq(car.ownerId, ownerId),
							eq(car.version, existing.version),
							lifecycleBase,
						),
					),
				maintenanceUpdate,
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
							eq(syncOperation.operationId, operationId.data),
							eq(syncOperation.requestHash, requestHash),
							eq(syncOperation.outcome, 'pending'),
							operationWitness(),
						),
					),
			]);
			return requireTerminalReceipt();
		}

		const createCar = carInput.safeParse(command.car);
		if (!createCar.success) return rejectValidation(createCar.error.flatten());

		const value = createCar.data;
		const createdCar = {
			id: command.carId,
			name: value.name,
			make: value.make ?? null,
			model: value.model ?? null,
			scale: value.scale ?? null,
			vehicleType: value.vehicleType ?? null,
			powerType: value.powerType ?? null,
			notes: value.notes ?? null,
			currentSetupId: null,
			createdAt: now,
			archivedAt: null,
			version: 1,
		};
		const response = {
			operationId: operationId.data,
			outcome: 'applied' as const,
			car: createdCar,
		};
		await database.batch([
			database.insert(car).values({
				...createdCar,
				ownerId,
				lastOperationId: operationId.data,
			}),
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
						eq(syncOperation.operationId, operationId.data),
						eq(syncOperation.requestHash, requestHash),
						eq(syncOperation.outcome, 'pending'),
					),
				),
		]);
		return requireTerminalReceipt();
	});

	return routes;
};
