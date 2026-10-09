import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../../db';
import { car, component, maintenancePlan, serviceRecord } from '../../schema';
import type { AppEnv } from '../../types';
import { ownerTimezone } from './drive-records';
/**
 * Loads the owner-scoped Maintenance preparation snapshot, including Component
 * references and Drive usage needed by local due calculations. Keeps preparation
 * reads together so the client does not infer missing collections from one screen.
 */
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
		const components = await database
			.select({ component })
			.from(component)
			.innerJoin(car, eq(component.carId, car.id))
			.where(eq(car.ownerId, ownerId));
		return c.json({
			collections: cars.map((car) => ({
				carId: car.id,
				version: car.version,
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
