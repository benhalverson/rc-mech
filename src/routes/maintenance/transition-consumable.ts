import { eq } from 'drizzle-orm';
import { canWrite } from '../../car-policy';
import {
	canArchiveConsumable,
	canRestoreConsumable,
} from '../../consumable-policy';
import { db } from '../../db';
import { consumableMaintenanceEntry } from '../../schema';
import type { AppContext } from '../../types';
import { ownedCar } from '../cars/car-records';
import { required } from '../invariant';
import { ownedConsumable, publicConsumable } from './consumable-records';

export const transitionConsumable = async (c: AppContext) => {
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
				error: 'Car is archived; restore it before changing consumable history',
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
