import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { canWrite } from '../../car-policy';
import {
	calculateConsumableReport,
	canEditConsumable,
	mapSetupTiresToAxles,
} from '../../consumable-policy';
import { db } from '../../db';
import { car, consumableMaintenanceEntry, setup } from '../../schema';
import {
	type AppEnv,
	consumableInput,
	consumableUpdateInput,
} from '../../types';
import { ownedCar } from '../cars/car-records';
import { required } from '../invariant';
import { jsonText, jsonValue } from '../json-values';
import {
	consumableInsertValues,
	ownedConsumable,
	publicConsumable,
} from './consumable-records';
import { transitionConsumable } from './transition-consumable';

export const createConsumableRoutes = () => {
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

	routes.post('/consumables/:entryId/archive', transitionConsumable);
	routes.post('/consumables/:entryId/restore', transitionConsumable);

	return routes;
};
