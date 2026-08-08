import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { canArchive, canRestore, carListMode } from '../../car-policy';
import { db } from '../../db';
import { car, maintenancePlan } from '../../schema';
import { type AppEnv, carInput, carUpdateInput } from '../../types';
import { required } from '../invariant';
import { ownedCar, publicCar } from './car-records';

export const createCarRoutes = () => {
	const routes = new Hono<AppEnv>();

	routes.get('/cars', async (c) => {
		const database = db(c.env);
		const archived = c.req.query('archived');
		const listMode = carListMode(archived);
		if (listMode === 'invalid')
			return c.json({ error: 'archived must be true or all' }, 400);
		const ownerFilter = eq(car.ownerId, c.get('userId'));
		const where =
			listMode === 'archived'
				? and(ownerFilter, isNotNull(car.archivedAt))
				: listMode === 'all'
					? ownerFilter
					: and(ownerFilter, isNull(car.archivedAt));
		const cars = await database
			.select()
			.from(car)
			.where(where)
			.orderBy(desc(car.createdAt));
		return c.json({
			cars: cars.map(publicCar),
			archived: archived === 'true' || archived === 'all',
		});
	});

	routes.post('/cars', async (c) => {
		const parsed = carInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const value = parsed.data;
		const database = db(c.env);
		await database.insert(car).values({
			id,
			ownerId: c.get('userId'),
			name: value.name,
			make: value.make ?? null,
			model: value.model ?? null,
			scale: value.scale ?? null,
			vehicleType: value.vehicleType ?? null,
			powerType: value.powerType ?? null,
			notes: value.notes ?? null,
			createdAt: now,
		});
		const created = await ownedCar(c, id);
		return c.json(
			{ car: publicCar(required(created, 'Created car could not be loaded')) },
			201,
		);
	});

	routes.get('/cars/:carId', async (c) => {
		const value = await ownedCar(c, c.req.param('carId'));
		if (!value) return c.json({ error: 'Car not found' }, 404);
		return c.json({ car: publicCar(value) });
	});

	routes.patch('/cars/:carId', async (c) => {
		const parsed = carUpdateInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const existing = await ownedCar(c, c.req.param('carId'));
		if (!existing) return c.json({ error: 'Car not found' }, 404);
		await db(c.env)
			.update(car)
			.set(parsed.data)
			.where(and(eq(car.id, existing.id), eq(car.ownerId, c.get('userId'))));
		const updated = await ownedCar(c, existing.id);
		return c.json({
			car: publicCar(required(updated, 'Updated car could not be loaded')),
		});
	});

	routes.post('/cars/:carId/archive', async (c) => {
		const existing = await ownedCar(c, c.req.param('carId'));
		if (!existing) return c.json({ error: 'Car not found' }, 404);
		if (!canArchive(existing))
			return c.json({ error: 'Car is already archived' }, 409);
		const archivedAt = new Date().toISOString();
		const database = db(c.env);
		await database.batch([
			database
				.update(car)
				.set({ archivedAt })
				.where(and(eq(car.id, existing.id), eq(car.ownerId, c.get('userId')))),
			database
				.update(maintenancePlan)
				.set({ status: 'paused', pauseReason: 'car', pausedAt: archivedAt })
				.where(
					and(
						eq(maintenancePlan.carId, existing.id),
						eq(maintenancePlan.status, 'active'),
					),
				),
		]);
		const archived = await ownedCar(c, existing.id);
		return c.json({
			car: publicCar(required(archived, 'Archived car could not be loaded')),
		});
	});

	routes.post('/cars/:carId/restore', async (c) => {
		const existing = await ownedCar(c, c.req.param('carId'));
		if (!existing) return c.json({ error: 'Car not found' }, 404);
		if (!canRestore(existing))
			return c.json({ error: 'Car is already active' }, 409);
		const database = db(c.env);
		await database.batch([
			database
				.update(car)
				.set({ archivedAt: null })
				.where(and(eq(car.id, existing.id), eq(car.ownerId, c.get('userId')))),
			database
				.update(maintenancePlan)
				.set({ status: 'active', pauseReason: null, pausedAt: null })
				.where(
					and(
						eq(maintenancePlan.carId, existing.id),
						eq(maintenancePlan.status, 'paused'),
						eq(maintenancePlan.pauseReason, 'car'),
					),
				),
		]);
		const restored = await ownedCar(c, existing.id);
		return c.json({
			car: publicCar(required(restored, 'Restored car could not be loaded')),
		});
	});

	return routes;
};
