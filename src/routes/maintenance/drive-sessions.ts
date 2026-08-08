import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { canWrite } from '../../car-policy';
import { db } from '../../db';
import {
	canDeleteDriveSession,
	canEditDriveSession,
	isIanaTimezone,
} from '../../drive-session-policy';
import { driveSession, owner } from '../../schema';
import {
	type AppEnv,
	driveSessionInput,
	driveSessionUpdateInput,
	timezoneInput,
} from '../../types';
import { ownedCar } from '../cars/car-records';
import { required } from '../invariant';
import {
	driveSessionCount,
	ownerTimezone,
	publicDriveSession,
} from './drive-records';

export const createDriveSessionRoutes = () => {
	const routes = new Hono<AppEnv>();

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

	return routes;
};
