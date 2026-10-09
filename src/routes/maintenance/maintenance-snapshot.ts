import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../../db';
import {
	car,
	component,
	consumableMaintenanceEntry,
	maintenancePlan,
	serviceRecord,
} from '../../schema';
import type { AppEnv } from '../../types';
import { ownerTimezone } from './drive-records';
export const createMaintenanceSnapshotRoutes = () => {
	const routes = new Hono<AppEnv>();
	routes.get('/maintenance/sync/snapshot', async (c) => {
		const database = db(c.env);
		const ownerId = c.get('userId');
		const cars = await database
			.select({ id: car.id, version: car.version })
			.from(car)
			.where(eq(car.ownerId, ownerId));
		const plans = await database
			.select({ plan: maintenancePlan })
			.from(maintenancePlan)
			.innerJoin(car, eq(maintenancePlan.carId, car.id))
			.where(eq(car.ownerId, ownerId));
		const records = await database
			.select({ record: serviceRecord })
			.from(serviceRecord)
			.innerJoin(car, eq(serviceRecord.carId, car.id))
			.where(eq(car.ownerId, ownerId));
		const consumables = await database
			.select({ entry: consumableMaintenanceEntry })
			.from(consumableMaintenanceEntry)
			.innerJoin(car, eq(consumableMaintenanceEntry.carId, car.id))
			.where(eq(car.ownerId, ownerId));
		const components = await database
			.select({ component })
			.from(component)
			.innerJoin(car, eq(component.carId, car.id))
			.where(eq(car.ownerId, ownerId));
		return c.json({
			collections: cars.map((car) => ({
				carId: car.id,
				version: car.version,
				consumables: consumables
					.map((row) => row.entry)
					.filter((entry) => entry.carId === car.id),
				plans: plans
					.map((row) => row.plan)
					.filter((plan) => plan.carId === car.id),
				records: records
					.map((row) => row.record)
					.filter((record) => record.carId === car.id),
			})),
			components: components.map((row) => row.component),
			timezone: await ownerTimezone(c),
		});
	});
	return routes;
};
