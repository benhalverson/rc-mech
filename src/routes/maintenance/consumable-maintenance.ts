import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { canWrite } from '../../car-policy';
import { canEditConsumable } from '../../consumable-policy';
import { db } from '../../db';
import { car, consumableMaintenanceEntry } from '../../schema';
import {
	type AppEnv,
	consumableInput,
	consumableUpdateInput,
} from '../../types';
import { ownedCar } from '../cars/car-records';
import { required } from '../invariant';
import { jsonText } from '../json-values';
import {
	legacyConsumableInput,
	legacyConsumableResponse,
} from './consumable-compatibility';
import {
	consumableInsertValues,
	ownedConsumable,
	publicConsumable,
} from './consumable-records';
import { transitionConsumable } from './transition-consumable';

export const createConsumableMaintenanceRoutes = () => {
	const routes = new Hono<AppEnv>();

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

	return routes;
};
