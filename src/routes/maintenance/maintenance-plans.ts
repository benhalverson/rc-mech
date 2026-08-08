import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { canWrite } from '../../car-policy';
import { db } from '../../db';
import {
	canTransitionMaintenance,
	type MaintenanceStatus,
} from '../../maintenance-policy';
import { car, maintenancePlan, serviceRecord } from '../../schema';
import {
	type AppContext,
	type AppEnv,
	maintenanceCompletionInput,
	maintenancePlanInput,
	maintenancePlanUpdateInput,
} from '../../types';
import { ownedCar, ownedComponent } from '../cars/car-records';
import { required } from '../invariant';
import { ownerTimezone, sessionCountsForCars } from './drive-records';
import { carPlan, planDue, planSessionCount } from './plan-records';

export const createMaintenancePlanRoutes = () => {
	const routes = new Hono<AppEnv>();

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

	return routes;
};
