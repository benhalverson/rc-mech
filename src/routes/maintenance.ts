import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { canWrite } from '../car-policy';
import {
	calculateConsumableReport,
	canArchiveConsumable,
	canEditConsumable,
	canRestoreConsumable,
	mapSetupTiresToAxles,
} from '../consumable-policy';
import { db } from '../db';
import {
	canDeleteDriveSession,
	canEditDriveSession,
	isIanaTimezone,
} from '../drive-session-policy';
import {
	canTransitionMaintenance,
	type MaintenanceStatus,
} from '../maintenance-policy';
import {
	car,
	consumableMaintenanceEntry,
	driveSession,
	maintenancePlan,
	owner,
	serviceRecord,
	setup,
} from '../schema';
import {
	canDeleteServiceRecord,
	canEditServiceRecord,
	shouldRestoreBaseline,
} from '../service-policy';
import {
	AppContext,
	AppEnv,
	consumableInput,
	consumableUpdateInput,
	driveSessionInput,
	driveSessionUpdateInput,
	maintenanceCompletionInput,
	maintenancePlanInput,
	maintenancePlanUpdateInput,
	serviceRecordInput,
	serviceRecordUpdateInput,
	timezoneInput,
} from '../types';

import {
	carPlan,
	consumableInsertValues,
	driveSessionCount,
	jsonText,
	jsonValue,
	ownedCar,
	ownedComponent,
	ownedConsumable,
	ownerTimezone,
	planDue,
	planSessionCount,
	publicConsumable,
	publicDriveSession,
	required,
	sessionCountsForCars,
} from './shared';

export const createMaintenanceRoutes = () => {
	const routes = new Hono<AppEnv>();

	routes.get('/cars/:carId/consumables/prefill', async (c) => {
		const carId = c.req.param('carId');
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!parentCar.currentSetupId)
			return c.json({ setupId: null, front: null, rear: null });
		const current = await db(c.env)
			.select()
			.from(setup)
			.where(
				and(eq(setup.id, parentCar.currentSetupId), eq(setup.carId, carId)),
			)
			.get();
		if (!current) return c.json({ setupId: null, front: null, rear: null });
		const mapped = mapSetupTiresToAxles(jsonValue(current.tires));
		return c.json({ setupId: current.id, ...mapped });
	});

	routes.get('/cars/:carId/consumables', async (c) => {
		const carId = c.req.param('carId');
		if (!(await ownedCar(c, carId)))
			return c.json({ error: 'Car not found' }, 404);
		const archived = c.req.query('archived');
		const condition =
			archived === 'all'
				? eq(consumableMaintenanceEntry.carId, carId)
				: archived === 'true'
					? and(
							eq(consumableMaintenanceEntry.carId, carId),
							isNotNull(consumableMaintenanceEntry.archivedAt),
						)
					: and(
							eq(consumableMaintenanceEntry.carId, carId),
							isNull(consumableMaintenanceEntry.archivedAt),
						);
		const values = await db(c.env)
			.select()
			.from(consumableMaintenanceEntry)
			.where(condition)
			.orderBy(
				desc(consumableMaintenanceEntry.performedAt),
				desc(consumableMaintenanceEntry.createdAt),
			);
		return c.json({ consumables: values.map(publicConsumable) });
	});

	routes.get('/cars/:carId/consumables/report', async (c) => {
		const carId = c.req.param('carId');
		if (!(await ownedCar(c, carId)))
			return c.json({ error: 'Car not found' }, 404);
		const values = await db(c.env)
			.select()
			.from(consumableMaintenanceEntry)
			.where(
				and(
					eq(consumableMaintenanceEntry.carId, carId),
					isNull(consumableMaintenanceEntry.archivedAt),
				),
			)
			.orderBy(
				desc(consumableMaintenanceEntry.performedAt),
				desc(consumableMaintenanceEntry.createdAt),
			);
		return c.json({ report: calculateConsumableReport(values) });
	});

	routes.post('/cars/:carId/consumables', async (c) => {
		const carId = c.req.param('carId');
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before recording consumables' },
				409,
			);
		const parsed = consumableInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		let value = parsed.data;
		let prefilledFromSetupId: string | null = null;
		if (value.kind === 'tires' && value.prefillFromCurrentSetup) {
			if (parentCar.currentSetupId) {
				const current = await db(c.env)
					.select()
					.from(setup)
					.where(
						and(eq(setup.id, parentCar.currentSetupId), eq(setup.carId, carId)),
					)
					.get();
				if (current) {
					const mapped = mapSetupTiresToAxles(jsonValue(current.tires));
					value = {
						...value,
						front:
							value.front ??
							(mapped.front ? { details: mapped.front } : undefined),
						rear:
							value.rear ??
							(mapped.rear ? { details: mapped.rear } : undefined),
					};
					prefilledFromSetupId = current.id;
				}
			}
			if (!value.front && !value.rear)
				return c.json(
					{ error: 'Current setup has no tire details to prefill' },
					400,
				);
		}
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const created = await db(c.env)
			.insert(consumableMaintenanceEntry)
			.values(
				consumableInsertValues(id, carId, value, now, prefilledFromSetupId),
			)
			.returning()
			.get();
		return c.json(
			{
				consumable: publicConsumable(
					required(created, 'Created consumable could not be loaded'),
				),
			},
			201,
		);
	});

	routes.get('/consumables/report', async (c) => {
		const values = await db(c.env)
			.select()
			.from(consumableMaintenanceEntry)
			.innerJoin(car, eq(consumableMaintenanceEntry.carId, car.id))
			.where(
				and(
					eq(car.ownerId, c.get('userId')),
					isNull(consumableMaintenanceEntry.archivedAt),
				),
			)
			.orderBy(
				desc(consumableMaintenanceEntry.performedAt),
				desc(consumableMaintenanceEntry.createdAt),
			);
		return c.json({
			report: calculateConsumableReport(
				values.map(
					({ consumable_maintenance_entry }) => consumable_maintenance_entry,
				),
			),
		});
	});

	routes.get('/consumables/:entryId', async (c) => {
		const value = await ownedConsumable(c, c.req.param('entryId'));
		if (!value) return c.json({ error: 'Consumable entry not found' }, 404);
		return c.json({ consumable: publicConsumable(value) });
	});

	routes.patch('/consumables/:entryId', async (c) => {
		const existing = await ownedConsumable(c, c.req.param('entryId'));
		if (!existing) return c.json({ error: 'Consumable entry not found' }, 404);
		const parentCar = await ownedCar(c, existing.carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar) || !canEditConsumable(existing))
			return c.json({ error: 'Archived cars and entries are read-only' }, 409);
		const parsed = consumableUpdateInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const value = parsed.data;
		if (
			existing.kind === 'fluid' &&
			(value.front !== undefined || value.rear !== undefined)
		)
			return c.json({ error: 'Fluid entries cannot have tire axles' }, 400);
		if (
			existing.kind === 'tires' &&
			(value.fluidArea !== undefined ||
				value.customFluidArea !== undefined ||
				value.cost !== undefined ||
				value.currency !== undefined)
		)
			return c.json({ error: 'Tire entries cannot have fluid fields' }, 400);
		const nextFront =
			value.front === undefined
				? existing.frontDetails
				: value.front === null
					? null
					: jsonText(value.front);
		const nextRear =
			value.rear === undefined
				? existing.rearDetails
				: value.rear === null
					? null
					: jsonText(value.rear);
		if (existing.kind === 'tires' && !nextFront && !nextRear)
			return c.json({ error: 'A front or rear tire set is required' }, 400);
		if (existing.kind === 'fluid') {
			const nextArea = value.fluidArea ?? existing.fluidArea;
			const nextCustom =
				value.customFluidArea === undefined
					? existing.customFluidArea
					: value.customFluidArea;
			if (nextArea === 'custom' && !nextCustom)
				return c.json({ error: 'Custom fluid area is required' }, 400);
			if (nextArea !== 'custom' && nextCustom)
				return c.json(
					{ error: 'Custom fluid area is only valid for custom' },
					400,
				);
		}
		await db(c.env)
			.update(consumableMaintenanceEntry)
			.set({
				performedAt: value.performedAt
					? new Date(value.performedAt).toISOString()
					: undefined,
				notes: value.notes,
				fluidArea: value.fluidArea,
				customFluidArea: value.customFluidArea,
				cost: value.cost,
				currency: value.currency,
				frontDetails:
					value.front === undefined
						? undefined
						: value.front === null
							? null
							: jsonText(value.front),
				frontCost:
					value.front === undefined ? undefined : (value.front?.cost ?? null),
				frontCurrency:
					value.front === undefined
						? undefined
						: (value.front?.currency ?? null),
				rearDetails:
					value.rear === undefined
						? undefined
						: value.rear === null
							? null
							: jsonText(value.rear),
				rearCost:
					value.rear === undefined ? undefined : (value.rear?.cost ?? null),
				rearCurrency:
					value.rear === undefined ? undefined : (value.rear?.currency ?? null),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(consumableMaintenanceEntry.id, existing.id));
		const updated = await ownedConsumable(c, existing.id);
		return c.json({
			consumable: publicConsumable(
				required(updated, 'Updated consumable could not be loaded'),
			),
		});
	});

	const transitionConsumable = async (c: AppContext) => {
		const existing = await ownedConsumable(c, c.req.param('entryId'));
		if (!existing) return c.json({ error: 'Consumable entry not found' }, 404);
		if (c.req.param('carId') && existing.carId !== c.req.param('carId'))
			return c.json({ error: 'Consumable entry not found' }, 404);
		const parentCar = await ownedCar(c, existing.carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		const action =
			c.req.method === 'DELETE' || c.req.path.endsWith('/archive')
				? 'archive'
				: 'restore';
		if (!canWrite(parentCar))
			return c.json(
				{
					error:
						'Car is archived; restore it before changing consumable history',
				},
				409,
			);
		if (action === 'archive' && !canArchiveConsumable(existing))
			return c.json({ error: 'Consumable entry is already archived' }, 409);
		if (action === 'restore' && !canRestoreConsumable(existing))
			return c.json({ error: 'Consumable entry is already active' }, 409);
		const updated = await db(c.env)
			.update(consumableMaintenanceEntry)
			.set({
				archivedAt: action === 'archive' ? new Date().toISOString() : null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(consumableMaintenanceEntry.id, existing.id))
			.returning()
			.get();
		const result = publicConsumable(
			required(updated, 'Consumable transition failed'),
		);
		return c.json({ consumable: result, consumableMaintenance: result });
	};
	routes.post('/consumables/:entryId/archive', transitionConsumable);
	routes.post('/consumables/:entryId/restore', transitionConsumable);

	// Compatibility aliases for the maintenance cockpit contract. The persisted model above
	// remains the canonical fluid/tires shape; these aliases only translate its flat UI payload.
	const legacyConsumableInput = (body: Record<string, unknown>) => {
		if (body.kind === 'tires') {
			const axle =
				body.axle === 'rear' ? 'rear' : body.axle === 'both' ? 'both' : 'front';
			const front =
				axle !== 'rear' &&
				(body.frontDetails !== undefined || body.frontCost !== undefined)
					? {
							details: body.frontDetails,
							cost: body.frontCost,
							currency: body.frontCost === undefined ? undefined : 'USD',
						}
					: undefined;
			const rear =
				axle !== 'front' &&
				(body.rearDetails !== undefined || body.rearCost !== undefined)
					? {
							details: body.rearDetails,
							cost: body.rearCost,
							currency: body.rearCost === undefined ? undefined : 'USD',
						}
					: undefined;
			return {
				kind: 'tires',
				performedAt: body.performedAt,
				notes: body.notes,
				front,
				rear,
			};
		}
		const fluidKind =
			body.kind === 'shock-fluid'
				? (body.fluidArea ?? 'front-shocks')
				: body.kind === 'differential-fluid'
					? (body.fluidArea ?? 'front-differential')
					: body.fluidArea;
		return {
			kind: 'fluid',
			performedAt: body.performedAt,
			notes: body.notes,
			fluidArea: fluidKind,
			customFluidArea: body.customArea,
			cost: body.cost,
			currency: body.cost === undefined ? undefined : 'USD',
		};
	};

	const legacyConsumableResponse = (
		value: typeof consumableMaintenanceEntry.$inferSelect,
	) => ({
		consumableMaintenance: publicConsumable(value),
	});

	routes.get('/consumable-maintenance', async (c) => {
		const values = await db(c.env)
			.select()
			.from(consumableMaintenanceEntry)
			.innerJoin(car, eq(consumableMaintenanceEntry.carId, car.id))
			.where(eq(car.ownerId, c.get('userId')))
			.orderBy(
				desc(consumableMaintenanceEntry.performedAt),
				desc(consumableMaintenanceEntry.createdAt),
			);
		return c.json({
			consumableMaintenance: values.map(({ consumable_maintenance_entry }) =>
				publicConsumable(consumable_maintenance_entry),
			),
		});
	});

	routes.get('/cars/:carId/consumable-maintenance', async (c) => {
		const carId = c.req.param('carId');
		if (!(await ownedCar(c, carId)))
			return c.json({ error: 'Car not found' }, 404);
		const values = await db(c.env)
			.select()
			.from(consumableMaintenanceEntry)
			.where(eq(consumableMaintenanceEntry.carId, carId))
			.orderBy(
				desc(consumableMaintenanceEntry.performedAt),
				desc(consumableMaintenanceEntry.createdAt),
			);
		return c.json({ consumableMaintenance: values.map(publicConsumable) });
	});

	routes.post('/cars/:carId/consumable-maintenance', async (c) => {
		const carId = c.req.param('carId');
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before recording maintenance' },
				409,
			);
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		const parsed = consumableInput.safeParse(legacyConsumableInput(body));
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const id = crypto.randomUUID();
		const created = await db(c.env)
			.insert(consumableMaintenanceEntry)
			.values(
				consumableInsertValues(
					id,
					carId,
					parsed.data,
					new Date().toISOString(),
					null,
				),
			)
			.returning()
			.get();
		return c.json(
			legacyConsumableResponse(
				required(created, 'Created consumable could not be loaded'),
			),
			201,
		);
	});

	routes.patch('/cars/:carId/consumable-maintenance/:entryId', async (c) => {
		const existing = await ownedConsumable(c, c.req.param('entryId'));
		if (!existing || existing.carId !== c.req.param('carId'))
			return c.json({ error: 'Consumable entry not found' }, 404);
		const parentCar = await ownedCar(c, existing.carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar) || !canEditConsumable(existing))
			return c.json({ error: 'Archived cars and entries are read-only' }, 409);
		const body = (await c.req.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		const parsed = consumableUpdateInput.safeParse(
			legacyConsumableInput({
				...body,
				fluidArea: body.fluidArea ?? existing.fluidArea,
				customArea: body.customArea ?? existing.customFluidArea,
				kind:
					existing.kind === 'tires'
						? 'tires'
						: existing.fluidArea?.includes('shocks')
							? 'shock-fluid'
							: 'differential-fluid',
			}),
		);
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		await db(c.env)
			.update(consumableMaintenanceEntry)
			.set({
				performedAt: parsed.data.performedAt
					? new Date(parsed.data.performedAt).toISOString()
					: undefined,
				notes: parsed.data.notes,
				fluidArea: parsed.data.fluidArea,
				customFluidArea: parsed.data.customFluidArea,
				cost: parsed.data.cost,
				currency: parsed.data.currency,
				frontDetails:
					parsed.data.front === undefined
						? undefined
						: jsonText(parsed.data.front),
				frontCost:
					parsed.data.front === undefined
						? undefined
						: (parsed.data.front?.cost ?? null),
				frontCurrency:
					parsed.data.front === undefined
						? undefined
						: (parsed.data.front?.currency ?? null),
				rearDetails:
					parsed.data.rear === undefined
						? undefined
						: jsonText(parsed.data.rear),
				rearCost:
					parsed.data.rear === undefined
						? undefined
						: (parsed.data.rear?.cost ?? null),
				rearCurrency:
					parsed.data.rear === undefined
						? undefined
						: (parsed.data.rear?.currency ?? null),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(consumableMaintenanceEntry.id, existing.id));
		return c.json(
			legacyConsumableResponse(
				required(
					await ownedConsumable(c, existing.id),
					'Updated consumable could not be loaded',
				),
			),
		);
	});

	routes.delete(
		'/cars/:carId/consumable-maintenance/:entryId',
		transitionConsumable,
	);
	routes.post(
		'/cars/:carId/consumable-maintenance/:entryId/restore',
		transitionConsumable,
	);

	routes.get('/preferences/timezone', async (c) =>
		c.json({ timezone: await ownerTimezone(c) }),
	);

	routes.patch('/preferences/timezone', async (c) => {
		const parsed = timezoneInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		if (!isIanaTimezone(parsed.data.timezone)) {
			return c.json({ error: 'timezone must be a valid IANA timezone' }, 400);
		}
		await db(c.env)
			.update(owner)
			.set({ timezone: parsed.data.timezone })
			.where(eq(owner.id, c.get('userId')));
		return c.json({ timezone: parsed.data.timezone });
	});

	routes.get('/cars/:carId/drives/count', async (c) => {
		if (!(await ownedCar(c, c.req.param('carId'))))
			return c.json({ error: 'Car not found' }, 404);
		return c.json({ count: await driveSessionCount(c, c.req.param('carId')) });
	});

	routes.get('/cars/:carId/drives', async (c) => {
		const { carId } = c.req.param();
		if (!(await ownedCar(c, carId)))
			return c.json({ error: 'Car not found' }, 404);
		const history = c.req.query('history') === 'true';
		const where = history
			? eq(driveSession.carId, carId)
			: and(eq(driveSession.carId, carId), isNull(driveSession.deletedAt));
		const timezone = await ownerTimezone(c);
		const sessions = await db(c.env)
			.select()
			.from(driveSession)
			.where(where)
			.orderBy(desc(driveSession.startedAt));
		return c.json({
			driveSessions: sessions.map((value) =>
				publicDriveSession(value, timezone),
			),
			count: sessions.filter((value) => value.deletedAt === null).length,
			history,
			timezone,
		});
	});

	routes.post('/cars/:carId/drives', async (c) => {
		const carId = c.req.param('carId');
		const parsed = driveSessionInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before recording new work' },
				409,
			);
		const id = crypto.randomUUID();
		const value = parsed.data;
		const database = db(c.env);
		await database.insert(driveSession).values({
			id,
			carId,
			startedAt: new Date(value.startedAt).toISOString(),
			durationMinutes: value.durationMinutes ?? null,
			conditions: value.conditions ?? null,
			notes: value.notes ?? null,
			deletedAt: null,
		});
		const created = await database
			.select()
			.from(driveSession)
			.where(and(eq(driveSession.id, id), eq(driveSession.carId, carId)))
			.get();
		return c.json(
			{
				driveSession: publicDriveSession(
					required(created, 'Created drive session could not be loaded'),
					await ownerTimezone(c),
				),
			},
			201,
		);
	});

	routes.patch('/cars/:carId/drives/:driveId', async (c) => {
		const { carId, driveId } = c.req.param();
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before editing drive history' },
				409,
			);
		const existing = await db(c.env)
			.select()
			.from(driveSession)
			.where(and(eq(driveSession.id, driveId), eq(driveSession.carId, carId)))
			.get();
		if (!existing) return c.json({ error: 'Drive session not found' }, 404);
		if (!canEditDriveSession(existing))
			return c.json({ error: 'Deleted drive sessions are immutable' }, 409);
		const parsed = driveSessionUpdateInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		await db(c.env)
			.update(driveSession)
			.set({
				startedAt: parsed.data.startedAt
					? new Date(parsed.data.startedAt).toISOString()
					: undefined,
				durationMinutes: parsed.data.durationMinutes,
				conditions: parsed.data.conditions,
				notes: parsed.data.notes,
			})
			.where(
				and(
					eq(driveSession.id, driveId),
					eq(driveSession.carId, carId),
					isNull(driveSession.deletedAt),
				),
			);
		const updated = await db(c.env)
			.select()
			.from(driveSession)
			.where(
				and(
					eq(driveSession.id, driveId),
					eq(driveSession.carId, carId),
					isNull(driveSession.deletedAt),
				),
			)
			.get();
		if (!updated)
			return c.json({ error: 'Drive session is no longer editable' }, 409);
		return c.json({
			driveSession: publicDriveSession(
				required(updated, 'Updated drive session could not be loaded'),
				await ownerTimezone(c),
			),
		});
	});

	routes.delete('/cars/:carId/drives/:driveId', async (c) => {
		const { carId, driveId } = c.req.param();
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before deleting drive history' },
				409,
			);
		const existing = await db(c.env)
			.select()
			.from(driveSession)
			.where(and(eq(driveSession.id, driveId), eq(driveSession.carId, carId)))
			.get();
		if (!existing) return c.json({ error: 'Drive session not found' }, 404);
		if (!canDeleteDriveSession(existing))
			return c.json({ error: 'Drive session is already deleted' }, 409);
		const deletedAt = new Date().toISOString();
		await db(c.env)
			.update(driveSession)
			.set({ deletedAt })
			.where(
				and(
					eq(driveSession.id, driveId),
					eq(driveSession.carId, carId),
					isNull(driveSession.deletedAt),
				),
			);
		const deleted = { ...existing, deletedAt };
		return c.json({
			driveSession: publicDriveSession(deleted, await ownerTimezone(c)),
		});
	});

	routes.post('/cars/:carId/service-records', async (c) => {
		const parsed = serviceRecordInput.safeParse({
			...(await c.req.json()),
			carId: c.req.param('carId'),
		});
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const parentCar = await ownedCar(c, parsed.data.carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before recording new work' },
				409,
			);
		if (
			parsed.data.componentId &&
			!(await ownedComponent(c, parsed.data.carId, parsed.data.componentId))
		)
			return c.json({ error: 'Component not found' }, 404);
		const id = crypto.randomUUID();
		const value = parsed.data;
		const baselineAt = value.baselineAt ?? value.performedAt;
		const database = db(c.env);
		await database.insert(serviceRecord).values({
			id,
			carId: value.carId,
			componentId: value.componentId ?? null,
			performedAt: value.performedAt,
			description:
				value.description ??
				required(value.notes, 'Validated service record is missing its notes'),
			notes: value.notes ?? null,
			cost: value.cost ?? null,
			currency: value.currency ?? null,
			baselineAt,
			baselineSessionCount: null,
			previousBaselineAt: null,
			previousBaselineSessionCount: null,
			deletedAt: null,
		});
		const created = await database
			.select()
			.from(serviceRecord)
			.where(eq(serviceRecord.id, id))
			.get();
		return c.json({ serviceRecord: created }, 201);
	});

	routes.get('/service-records', async (c) => {
		const records = await db(c.env)
			.select()
			.from(serviceRecord)
			.innerJoin(car, eq(serviceRecord.carId, car.id))
			.where(eq(car.ownerId, c.get('userId')))
			.orderBy(desc(serviceRecord.performedAt));
		return c.json({
			serviceRecords: records.map(({ service_record }) => service_record),
		});
	});

	routes.post('/maintenance-plans', async (c) => {
		const parsed = maintenancePlanInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const parentCar = await ownedCar(c, parsed.data.carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before recording new work' },
				409,
			);
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const value = parsed.data;
		const intervalUnit =
			value.intervalUnit ??
			(value.intervalDays !== undefined ? 'days' : 'none');
		const intervalValue = value.intervalValue ?? value.intervalDays ?? 1;
		if (value.componentId !== undefined) {
			const target = await ownedComponent(c, value.carId, value.componentId);
			if (!target || target.removedAt !== null)
				return c.json(
					{ error: 'Maintenance plans require a current component' },
					409,
				);
		}
		const database = db(c.env);
		const baselineAt = value.baselineAt
			? new Date(value.baselineAt).toISOString()
			: now;
		const baselineSessionCount =
			value.baselineSessionCount ?? (await planSessionCount(c, value.carId));
		await database.insert(maintenancePlan).values({
			id,
			carId: value.carId,
			componentId: value.componentId,
			name: value.name,
			intervalDays: value.intervalDays ?? null,
			intervalSessions: value.intervalSessions ?? null,
			intervalUnit,
			intervalValue,
			baselineAt,
			baselineSessionCount,
			status: 'active',
			pauseReason: null,
			pausedAt: null,
		});
		const created = await database
			.select()
			.from(maintenancePlan)
			.where(eq(maintenancePlan.id, id))
			.get();
		return c.json(
			{
				maintenancePlan: planDue(
					required(created, 'Created maintenance plan could not be loaded'),
					baselineSessionCount,
					await ownerTimezone(c),
				),
			},
			201,
		);
	});

	routes.get('/maintenance-plans', async (c) => {
		const plans = await db(c.env)
			.select()
			.from(maintenancePlan)
			.innerJoin(car, eq(maintenancePlan.carId, car.id))
			.where(eq(car.ownerId, c.get('userId')));
		const timezone = await ownerTimezone(c);
		const values = plans.map(({ maintenance_plan: value }) => value);
		const counts = await sessionCountsForCars(c, [
			...new Set(values.map((value) => value.carId)),
		]);
		const maintenancePlans = values.map((value) =>
			planDue(value, counts.get(value.carId) ?? 0, timezone),
		);
		const records = await db(c.env)
			.select()
			.from(serviceRecord)
			.innerJoin(car, eq(serviceRecord.carId, car.id))
			.where(
				and(eq(car.ownerId, c.get('userId')), isNull(serviceRecord.deletedAt)),
			)
			.orderBy(desc(serviceRecord.performedAt))
			.limit(20);
		const activity = records.map(({ service_record: value }) => ({
			id: value.id,
			planId: value.planId,
			action: 'completed',
			occurredAt: value.performedAt,
			note: value.description,
		}));
		return c.json({ maintenancePlans, activity });
	});

	routes.get('/cars/:carId/maintenance-plans', async (c) => {
		const carId = c.req.param('carId');
		if (!(await ownedCar(c, carId)))
			return c.json({ error: 'Car not found' }, 404);
		const plans = await db(c.env)
			.select()
			.from(maintenancePlan)
			.where(eq(maintenancePlan.carId, carId));
		const timezone = await ownerTimezone(c);
		const count = await planSessionCount(c, carId);
		return c.json({
			maintenancePlans: plans.map((value) => planDue(value, count, timezone)),
		});
	});

	routes.get('/cars/:carId/maintenance-cockpit', async (c) => {
		const carId = c.req.param('carId');
		if (!(await ownedCar(c, carId)))
			return c.json({ error: 'Car not found' }, 404);
		const plans = await db(c.env)
			.select()
			.from(maintenancePlan)
			.where(eq(maintenancePlan.carId, carId));
		const timezone = await ownerTimezone(c);
		const count = await planSessionCount(c, carId);
		const enriched = plans.map((value) => planDue(value, count, timezone));
		return c.json({
			upcoming: enriched.filter((value) => value.dueStatus === 'upcoming'),
			due: enriched.filter((value) => value.dueStatus === 'due'),
			overdue: enriched.filter((value) => value.dueStatus === 'overdue'),
			paused: enriched.filter((value) => value.dueStatus === 'paused'),
			archived: enriched.filter((value) => value.dueStatus === 'archived'),
			recentActivity: await db(c.env)
				.select()
				.from(serviceRecord)
				.where(
					and(eq(serviceRecord.carId, carId), isNull(serviceRecord.deletedAt)),
				)
				.orderBy(desc(serviceRecord.performedAt))
				.limit(20),
		});
	});

	routes.get('/maintenance-cockpit', async (c) => {
		const cars = await db(c.env)
			.select({ id: car.id })
			.from(car)
			.where(eq(car.ownerId, c.get('userId')));
		const values = await db(c.env)
			.select({ plan: maintenancePlan })
			.from(maintenancePlan)
			.innerJoin(car, eq(maintenancePlan.carId, car.id))
			.where(eq(car.ownerId, c.get('userId')));
		const timezone = await ownerTimezone(c);
		const counts = await sessionCountsForCars(
			c,
			cars.map(({ id }) => id),
		);
		const plans = values.map(({ plan }) =>
			planDue(plan, counts.get(plan.carId) ?? 0, timezone),
		);
		return c.json({
			upcoming: plans.filter((value) => value.dueStatus === 'upcoming'),
			due: plans.filter((value) => value.dueStatus === 'due'),
			overdue: plans.filter((value) => value.dueStatus === 'overdue'),
			paused: plans.filter((value) => value.dueStatus === 'paused'),
			archived: plans.filter((value) => value.dueStatus === 'archived'),
		});
	});

	routes.patch('/maintenance-plans/:planId', async (c) => {
		const existing = await carPlan(c, c.req.param('planId'));
		if (!existing) return c.json({ error: 'Maintenance plan not found' }, 404);
		const parsed = maintenancePlanUpdateInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const intervalDays =
			parsed.data.intervalUnit === 'none'
				? null
				: parsed.data.intervalDays === null
					? null
					: (parsed.data.intervalDays ??
						(parsed.data.intervalUnit === 'days'
							? parsed.data.intervalValue
							: undefined));
		await db(c.env)
			.update(maintenancePlan)
			.set({
				name: parsed.data.name,
				intervalDays,
				intervalUnit:
					parsed.data.intervalUnit ??
					(intervalDays !== undefined ? 'days' : existing.intervalUnit),
				intervalValue:
					parsed.data.intervalValue ??
					(parsed.data.intervalUnit === 'none'
						? 1
						: (intervalDays ?? existing.intervalValue)),
				intervalSessions: parsed.data.intervalSessions,
			})
			.where(eq(maintenancePlan.id, existing.id));
		const updated = required(
			await carPlan(c, existing.id),
			'Updated maintenance plan could not be loaded',
		);
		return c.json({
			maintenancePlan: planDue(
				updated,
				await planSessionCount(c, updated.carId),
				await ownerTimezone(c),
			),
		});
	});

	const transitionMaintenancePlan = async (
		c: AppContext,
		action: 'pause' | 'resume' | 'archive',
	) => {
		const existing = await carPlan(c, c.req.param('planId'));
		if (!existing) return c.json({ error: 'Maintenance plan not found' }, 404);
		if (
			!canTransitionMaintenance(
				existing.status as MaintenanceStatus,
				action === 'pause'
					? 'paused'
					: action === 'resume'
						? 'active'
						: 'archived',
			)
		)
			return c.json({ error: 'Invalid maintenance plan state' }, 409);
		const nextStatus =
			action === 'pause'
				? 'paused'
				: action === 'resume'
					? 'active'
					: 'archived';
		try {
			await db(c.env)
				.update(maintenancePlan)
				.set({
					status: nextStatus,
					pauseReason: action === 'pause' ? 'manual' : null,
					pausedAt: action === 'pause' ? new Date().toISOString() : null,
				})
				.where(eq(maintenancePlan.id, existing.id));
			const updated = required(
				await carPlan(c, existing.id),
				'Updated maintenance plan could not be loaded',
			);
			return c.json({
				maintenancePlan: planDue(
					updated,
					await planSessionCount(c, updated.carId),
					await ownerTimezone(c),
				),
			});
		} catch (error) {
			console.error('maintenance plan transition failed', error);
			return c.json({ error: 'Maintenance plan transition failed' }, 500);
		}
	};
	routes.post('/maintenance-plans/:planId/pause', (c) =>
		transitionMaintenancePlan(c, 'pause'),
	);
	routes.post('/maintenance-plans/:planId/resume', (c) =>
		transitionMaintenancePlan(c, 'resume'),
	);
	routes.post('/maintenance-plans/:planId/archive', (c) =>
		transitionMaintenancePlan(c, 'archive'),
	);

	routes.post('/maintenance-plans/:planId/complete', async (c) => {
		const existing = await carPlan(c, c.req.param('planId'));
		if (!existing) return c.json({ error: 'Maintenance plan not found' }, 404);
		const parentCar = await ownedCar(c, existing.carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before recording new work' },
				409,
			);
		if (existing.status !== 'active')
			return c.json(
				{ error: 'Only active maintenance plans can be completed' },
				409,
			);
		const parsed = maintenanceCompletionInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const performedAt = parsed.data.performedAt
			? new Date(parsed.data.performedAt).toISOString()
			: new Date().toISOString();
		const description =
			parsed.data.description ??
			parsed.data.notes ??
			'Completed maintenance plan';
		const baselineSessionCount = await planSessionCount(c, existing.carId);
		const id = crypto.randomUUID();
		const database = db(c.env);
		await database.batch([
			database.insert(serviceRecord).values({
				id,
				carId: existing.carId,
				componentId: existing.componentId,
				planId: existing.id,
				performedAt,
				description,
				notes: parsed.data.notes ?? undefined,
				cost: parsed.data.cost ?? null,
				currency: parsed.data.currency ?? null,
				baselineAt: performedAt,
				baselineSessionCount,
				previousBaselineAt: existing.baselineAt,
				previousBaselineSessionCount: existing.baselineSessionCount,
				deletedAt: null,
			}),
			database
				.update(maintenancePlan)
				.set({ baselineAt: performedAt, baselineSessionCount })
				.where(eq(maintenancePlan.id, existing.id)),
		]);
		const updatedPlan = required(
			await carPlan(c, existing.id),
			'Updated maintenance plan could not be loaded',
		);
		return c.json(
			{
				serviceRecord: {
					id,
					planId: existing.id,
					performedAt,
					description,
					baselineAt: performedAt,
					baselineSessionCount,
				},
				maintenancePlan: planDue(
					updatedPlan,
					baselineSessionCount,
					await ownerTimezone(c),
				),
			},
			201,
		);
	});

	routes.get('/cars/:carId/service-records', async (c) => {
		const carId = c.req.param('carId');
		if (!(await ownedCar(c, carId)))
			return c.json({ error: 'Car not found' }, 404);
		const history = c.req.query('history') === 'true';
		const records = await db(c.env)
			.select()
			.from(serviceRecord)
			.where(
				history
					? eq(serviceRecord.carId, carId)
					: and(
							eq(serviceRecord.carId, carId),
							isNull(serviceRecord.deletedAt),
						),
			)
			.orderBy(desc(serviceRecord.performedAt));
		return c.json({ serviceRecords: records });
	});

	routes.patch('/service-records/:recordId', async (c) => {
		const record = await db(c.env)
			.select()
			.from(serviceRecord)
			.where(eq(serviceRecord.id, c.req.param('recordId')))
			.get();
		const parentCar = record ? await ownedCar(c, record.carId) : undefined;
		if (!record || !parentCar)
			return c.json({ error: 'Service record not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before editing service history' },
				409,
			);
		if (!canEditServiceRecord(record))
			return c.json({ error: 'Deleted service records are immutable' }, 409);
		const parsed = serviceRecordUpdateInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const nextPerformedAt = parsed.data.performedAt
			? new Date(parsed.data.performedAt).toISOString()
			: record.performedAt;
		const nextDescription = parsed.data.description ?? record.description;
		const nextNotes =
			parsed.data.notes === undefined ? record.notes : parsed.data.notes;
		const nextCost =
			parsed.data.cost === undefined ? record.cost : parsed.data.cost;
		const nextCurrency =
			parsed.data.currency === undefined
				? record.currency
				: parsed.data.currency;
		if ((nextCost === null) !== (nextCurrency === null))
			return c.json(
				{ error: 'Cost and currency must be supplied together' },
				400,
			);
		const database = db(c.env);
		const plan = record.planId
			? await database
					.select()
					.from(maintenancePlan)
					.where(eq(maintenancePlan.id, record.planId))
					.get()
			: undefined;
		const baselineIsCurrent = shouldRestoreBaseline(record, plan);
		const nextBaselineAt =
			baselineIsCurrent && parsed.data.performedAt
				? nextPerformedAt
				: record.baselineAt;
		await database.batch([
			database
				.update(serviceRecord)
				.set({
					performedAt: nextPerformedAt,
					description: nextDescription,
					notes: nextNotes,
					cost: nextCost,
					currency: nextCurrency,
					baselineAt: nextBaselineAt,
				})
				.where(
					and(eq(serviceRecord.id, record.id), isNull(serviceRecord.deletedAt)),
				),
			...(baselineIsCurrent && parsed.data.performedAt && plan
				? [
						database
							.update(maintenancePlan)
							.set({ baselineAt: nextPerformedAt })
							.where(
								and(
									eq(maintenancePlan.id, plan.id),
									eq(maintenancePlan.baselineAt, record.baselineAt),
								),
							),
					]
				: []),
		]);
		return c.json({
			serviceRecord: await database
				.select()
				.from(serviceRecord)
				.where(eq(serviceRecord.id, record.id))
				.get(),
		});
	});

	routes.delete('/service-records/:recordId', async (c) => {
		const record = await db(c.env)
			.select()
			.from(serviceRecord)
			.where(eq(serviceRecord.id, c.req.param('recordId')))
			.get();
		const parentCar = record ? await ownedCar(c, record.carId) : undefined;
		if (!record || !parentCar)
			return c.json({ error: 'Service record not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{
					error: 'Car is archived; restore it before deleting service history',
				},
				409,
			);
		if (!canDeleteServiceRecord(record))
			return c.json({ error: 'Service record is already deleted' }, 409);
		const database = db(c.env);
		const plan = record.planId
			? await db(c.env)
					.select()
					.from(maintenancePlan)
					.where(eq(maintenancePlan.id, record.planId))
					.get()
			: undefined;
		const deletedAt = new Date().toISOString();
		await database.batch([
			database
				.update(serviceRecord)
				.set({ deletedAt })
				.where(
					and(eq(serviceRecord.id, record.id), isNull(serviceRecord.deletedAt)),
				),
			...(shouldRestoreBaseline(record, plan) && plan
				? [
						database
							.update(maintenancePlan)
							.set({
								baselineAt: required(
									record.previousBaselineAt,
									'Previous service baseline is missing',
								),
								baselineSessionCount: record.previousBaselineSessionCount ?? 0,
							})
							.where(
								and(
									eq(maintenancePlan.id, plan.id),
									eq(maintenancePlan.baselineAt, record.baselineAt),
								),
							),
					]
				: []),
		]);
		return c.json({
			serviceRecord: { ...record, deletedAt },
			maintenancePlan: plan
				? await db(c.env)
						.select()
						.from(maintenancePlan)
						.where(eq(maintenancePlan.id, plan.id))
						.get()
				: undefined,
		});
	});

	routes.post('/service-records/:recordId/restore', async (c) => {
		const record = await db(c.env)
			.select()
			.from(serviceRecord)
			.where(eq(serviceRecord.id, c.req.param('recordId')))
			.get();
		const parentCar = record ? await ownedCar(c, record.carId) : undefined;
		if (!record || !parentCar)
			return c.json({ error: 'Service record not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{
					error: 'Car is archived; restore it before restoring service history',
				},
				409,
			);
		if (record.deletedAt === null)
			return c.json({ error: 'Service record is already active' }, 409);
		const database = db(c.env);
		const plan = record.planId
			? await database
					.select()
					.from(maintenancePlan)
					.where(eq(maintenancePlan.id, record.planId))
					.get()
			: undefined;
		await database.batch([
			database
				.update(serviceRecord)
				.set({ deletedAt: null })
				.where(
					and(
						eq(serviceRecord.id, record.id),
						isNotNull(serviceRecord.deletedAt),
					),
				),
			...(plan &&
			record.previousBaselineAt &&
			plan.baselineAt === record.previousBaselineAt
				? [
						database
							.update(maintenancePlan)
							.set({
								baselineAt: record.baselineAt,
								baselineSessionCount: record.baselineSessionCount ?? 0,
							})
							.where(
								and(
									eq(maintenancePlan.id, plan.id),
									eq(maintenancePlan.baselineAt, record.previousBaselineAt),
								),
							),
					]
				: []),
		]);
		return c.json({
			serviceRecord: await database
				.select()
				.from(serviceRecord)
				.where(eq(serviceRecord.id, record.id))
				.get(),
			maintenancePlan: plan
				? await database
						.select()
						.from(maintenancePlan)
						.where(eq(maintenancePlan.id, plan.id))
						.get()
				: undefined,
		});
	});

	return routes;
};
