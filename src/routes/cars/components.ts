import { and, desc, eq, getTableColumns, isNull, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { canWrite } from '../../car-policy';
import {
	canEditComponent,
	normalizeComponentSlot,
	STANDARD_COMPONENT_SLOTS,
} from '../../component-policy';
import { db } from '../../db';
import { car, component, maintenancePlan } from '../../schema';
import { type AppEnv, componentInput, componentUpdateInput } from '../../types';
import { required } from '../invariant';
import { planSessionCount } from '../maintenance/plan-records';
import {
	ownedCar,
	ownedComponent,
	parseComponentSlot,
	publicComponent,
} from './car-records';

/**
 * Legacy Component HTTP endpoints retained alongside durable Build replay.
 * Mutations advance the Car version so offline commands observe online changes
 * and cannot silently overwrite Component history edited through these routes.
 */
export const createComponentRoutes = () => {
	const routes = new Hono<AppEnv>();

	routes.post('/cars/:carId/components', async (c) => {
		const parsed = componentInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const { carId } = c.req.param();
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before recording new work' },
				409,
			);
		const slot = parseComponentSlot(parsed.data.slot, parsed.data.slotType);
		if (!slot)
			return c.json(
				{ error: 'slotType does not match the selected slot' },
				400,
			);
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const value = parsed.data;
		const database = db(c.env);
		const previous = await database
			.select()
			.from(component)
			.where(
				and(
					eq(component.carId, carId),
					eq(component.slot, slot.slot),
					isNull(component.removedAt),
				),
			)
			.get();
		const sessionCount = await planSessionCount(c, carId);
		await database.batch([
			database
				.update(car)
				.set({ version: sql`${car.version} + 1`, lastOperationId: null })
				.where(and(eq(car.id, carId), eq(car.ownerId, c.get('userId')))),
			database
				.update(component)
				.set({ removedAt: now })
				.where(
					and(
						eq(component.carId, carId),
						eq(component.slot, slot.slot),
						isNull(component.removedAt),
					),
				),
			...(previous
				? [
						database
							.update(maintenancePlan)
							.set({
								componentId: id,
								baselineAt: value.installedAt ?? now,
								baselineSessionCount: sessionCount,
								status: 'active',
								pauseReason: null,
								pausedAt: null,
							})
							.where(
								and(
									eq(maintenancePlan.componentId, previous.id),
									or(
										eq(maintenancePlan.status, 'active'),
										eq(maintenancePlan.pauseReason, 'component'),
									),
								),
							),
					]
				: []),
			database.insert(component).values({
				id,
				carId,
				slot: slot.slot,
				slotType: slot.slotType,
				name: value.name,
				manufacturer: value.manufacturer ?? null,
				model: value.model ?? null,
				serialNumber: value.serialNumber ?? null,
				notes: value.notes ?? null,
				installedAt: value.installedAt ?? now,
				removedAt: null,
			}),
		]);
		const created = await ownedComponent(c, carId, id);
		return c.json(
			{
				component: publicComponent(
					required(created, 'Created component could not be loaded'),
				),
			},
			201,
		);
	});

	routes.get('/components', async (c) => {
		const rows = await db(c.env)
			.select({
				ownerCarId: sql<string>`${car.id}`.as('ownerCarId'),
				version: car.version,
				component: getTableColumns(component),
			})
			.from(car)
			.leftJoin(component, eq(component.carId, car.id))
			.where(eq(car.ownerId, c.get('userId')));
		const collections = new Map<
			string,
			{
				carId: string;
				version: number;
				components: Array<typeof component.$inferSelect>;
			}
		>();
		for (const row of rows) {
			const collection = collections.get(row.ownerCarId) ?? {
				carId: row.ownerCarId,
				version: row.version,
				components: [],
			};
			if (row.component)
				collection.components.push(publicComponent(row.component));
			collections.set(row.ownerCarId, collection);
		}
		return c.json({ collections: [...collections.values()] });
	});

	routes.get('/component-slots', (c) =>
		c.json({ standard: STANDARD_COMPONENT_SLOTS }),
	);

	routes.get('/cars/:carId/components', async (c) => {
		const { carId } = c.req.param();
		const parent = await ownedCar(c, carId);
		if (!parent) return c.json({ error: 'Car not found' }, 404);
		const history = c.req.query('history') === 'true';
		const where = history
			? eq(component.carId, carId)
			: and(eq(component.carId, carId), isNull(component.removedAt));
		const components = await db(c.env)
			.select()
			.from(component)
			.where(where)
			.orderBy(desc(component.installedAt));
		return c.json({
			components: components.map(publicComponent),
			history,
			carId,
			version: parent.version,
		});
	});

	routes.get('/cars/:carId/components/:componentId', async (c) => {
		const { carId, componentId } = c.req.param();
		if (!(await ownedCar(c, carId)))
			return c.json({ error: 'Car not found' }, 404);
		const value = await ownedComponent(c, carId, componentId);
		if (!value) return c.json({ error: 'Component not found' }, 404);
		return c.json({ component: publicComponent(value) });
	});

	routes.patch('/cars/:carId/components/:componentId', async (c) => {
		const parsed = componentUpdateInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const { carId, componentId } = c.req.param();
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before recording new work' },
				409,
			);
		const existing = await ownedComponent(c, carId, componentId);
		if (!existing) return c.json({ error: 'Component not found' }, 404);
		if (!canEditComponent(existing.removedAt))
			return c.json(
				{ error: 'Historical component installations are immutable' },
				409,
			);
		const database = db(c.env);
		await database.batch([
			database
				.update(car)
				.set({ version: sql`${car.version} + 1`, lastOperationId: null })
				.where(and(eq(car.id, carId), eq(car.ownerId, c.get('userId')))),
			database
				.update(component)
				.set({
					name: parsed.data.name,
					manufacturer: parsed.data.manufacturer,
					model: parsed.data.model,
					serialNumber: parsed.data.serialNumber,
					notes: parsed.data.notes,
					installedAt: parsed.data.installedAt,
				})
				.where(and(eq(component.id, componentId), eq(component.carId, carId))),
		]);
		const updated = await ownedComponent(c, carId, componentId);
		return c.json({
			component: publicComponent(
				required(updated, 'Updated component could not be loaded'),
			),
		});
	});

	routes.post('/cars/:carId/components/:componentId/replace', async (c) => {
		const parsed = componentInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const { carId, componentId } = c.req.param();
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before recording new work' },
				409,
			);
		const previous = await ownedComponent(c, carId, componentId);
		if (!previous) return c.json({ error: 'Component not found' }, 404);
		if (previous.removedAt !== null)
			return c.json({ error: 'Component is no longer current' }, 409);
		const slot = parseComponentSlot(parsed.data.slot, parsed.data.slotType);
		if (!slot)
			return c.json(
				{ error: 'slotType does not match the selected slot' },
				400,
			);
		const previousSlot =
			previous.slotType === 'standard'
				? normalizeComponentSlot(previous.slot)
				: previous.slot.trim();
		if (slot.slot !== previousSlot)
			return c.json(
				{ error: 'Replacement must use the existing component slot' },
				400,
			);
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const database = db(c.env);
		const sessionCount = await planSessionCount(c, carId);
		await database.batch([
			database
				.update(car)
				.set({ version: sql`${car.version} + 1`, lastOperationId: null })
				.where(and(eq(car.id, carId), eq(car.ownerId, c.get('userId')))),
			database
				.update(component)
				.set({ removedAt: now })
				.where(
					and(
						eq(component.id, previous.id),
						eq(component.carId, carId),
						isNull(component.removedAt),
					),
				),
			database
				.update(maintenancePlan)
				.set({
					componentId: id,
					baselineAt: parsed.data.installedAt ?? now,
					baselineSessionCount: sessionCount,
					status: 'active',
					pauseReason: null,
					pausedAt: null,
				})
				.where(
					and(
						eq(maintenancePlan.componentId, previous.id),
						or(
							eq(maintenancePlan.status, 'active'),
							eq(maintenancePlan.pauseReason, 'component'),
						),
					),
				),
			database.insert(component).values({
				id,
				carId,
				slot: previous.slot,
				slotType: previous.slotType,
				name: parsed.data.name,
				manufacturer: parsed.data.manufacturer ?? null,
				model: parsed.data.model ?? null,
				serialNumber: parsed.data.serialNumber ?? null,
				notes: parsed.data.notes ?? null,
				installedAt: parsed.data.installedAt ?? now,
				removedAt: null,
			}),
		]);
		const replacement = await ownedComponent(c, carId, id);
		return c.json(
			{
				previous: publicComponent({ ...previous, removedAt: now }),
				component: publicComponent(
					required(replacement, 'Replacement component could not be loaded'),
				),
			},
			201,
		);
	});

	routes.post('/cars/:carId/components/:componentId/remove', async (c) => {
		const { carId, componentId } = c.req.param();
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before recording new work' },
				409,
			);
		const existing = await ownedComponent(c, carId, componentId);
		if (!existing) return c.json({ error: 'Component not found' }, 404);
		if (existing.removedAt !== null)
			return c.json({ error: 'Component is no longer current' }, 409);
		const removedAt = new Date().toISOString();
		const database = db(c.env);
		await database.batch([
			database
				.update(car)
				.set({ version: sql`${car.version} + 1`, lastOperationId: null })
				.where(and(eq(car.id, carId), eq(car.ownerId, c.get('userId')))),
			database
				.update(component)
				.set({ removedAt })
				.where(
					and(
						eq(component.id, componentId),
						eq(component.carId, carId),
						isNull(component.removedAt),
					),
				),
			database
				.update(maintenancePlan)
				.set({
					status: 'paused',
					pauseReason: 'component',
					pausedAt: removedAt,
				})
				.where(
					and(
						eq(maintenancePlan.componentId, componentId),
						eq(maintenancePlan.status, 'active'),
					),
				),
		]);
		return c.json({ component: publicComponent({ ...existing, removedAt }) });
	});

	return routes;
};
