import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { canWrite } from '../../car-policy';
import { db } from '../../db';
import { car, maintenancePlan, serviceRecord } from '../../schema';
import {
	canDeleteServiceRecord,
	canEditServiceRecord,
	shouldRestoreBaseline,
} from '../../service-policy';
import {
	type AppEnv,
	serviceRecordInput,
	serviceRecordUpdateInput,
} from '../../types';
import { ownedCar, ownedComponent } from '../cars/car-records';
import { required } from '../invariant';

export const createServiceRecordRoutes = () => {
	const routes = new Hono<AppEnv>();

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
