import { and, desc, eq, exists } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { alias } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
import { db } from '../../db';
import { car, setup } from '../../schema';
import {
	canWriteSetup,
	chooseCopySource,
	shouldSelectCurrentSetup,
} from '../../setup-policy';
import {
	type AppEnv,
	guardedSetupCopyInput,
	setupCopyInput,
	setupInput,
	setupUpdateInput,
} from '../../types';
import { ownedCar } from '../cars/car-records';
import { required } from '../invariant';
import { jsonText } from '../json-values';
import {
	nextSetupSelectionVersion,
	setupSelectionWitness,
} from './setup-concurrency';
import {
	ownedSetup,
	publicSetup,
	setupCopyValue,
	setupInsertSelection,
	setupInsertValues,
} from './setup-records';

export const createSetupSnapshotRoutes = () => {
	const routes = new Hono<AppEnv>();

	routes.get('/setups', async (c) => {
		const database = db(c.env);
		const ownerId = c.get('userId');
		const cars = await database
			.select({
				id: car.id,
				currentSetupId: car.currentSetupId,
				currentSetupVersion: car.currentSetupVersion,
			})
			.from(car)
			.where(eq(car.ownerId, ownerId));
		const setups = await database
			.select()
			.from(setup)
			.where(
				exists(
					database
						.select({ id: car.id })
						.from(car)
						.where(and(eq(car.id, setup.carId), eq(car.ownerId, ownerId))),
				),
			)
			.orderBy(desc(setup.updatedAt), desc(setup.createdAt));
		const setupsByCar = new Map<string, (typeof setups)[number][]>();
		for (const value of setups) {
			const values = setupsByCar.get(value.carId) ?? [];
			values.push(value);
			setupsByCar.set(value.carId, values);
		}
		return c.json({
			setupCollections: cars.map((parentCar) => ({
				carId: parentCar.id,
				currentSetupId: parentCar.currentSetupId,
				currentSetupVersion: parentCar.currentSetupVersion,
				setups: (setupsByCar.get(parentCar.id) ?? []).map((value) =>
					publicSetup(value, value.id === parentCar.currentSetupId),
				),
			})),
		});
	});

	routes.get('/cars/:carId/setups/current', async (c) => {
		const parentCar = await ownedCar(c, c.req.param('carId'));
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!parentCar.currentSetupId) return c.json({ setup: null });
		const current = await ownedSetup(c, parentCar.id, parentCar.currentSetupId);
		return c.json({ setup: current ? publicSetup(current, true) : null });
	});

	routes.get('/cars/:carId/setups', async (c) => {
		const carId = c.req.param('carId');
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		const values = await db(c.env)
			.select()
			.from(setup)
			.where(eq(setup.carId, carId))
			.orderBy(desc(setup.updatedAt), desc(setup.createdAt));
		return c.json({
			currentSetupId: parentCar.currentSetupId,
			currentSetupVersion: parentCar.currentSetupVersion,
			setups: values.map((value) =>
				publicSetup(value, value.id === parentCar?.currentSetupId),
			),
		});
	});

	routes.post('/cars/:carId/setups', async (c) => {
		const carId = c.req.param('carId');
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWriteSetup(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before editing setups' },
				409,
			);
		const parsed = setupInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const database = db(c.env);
		const value = setupInsertValues(id, carId, parsed.data, now);
		const makeCurrent = shouldSelectCurrentSetup(parsed.data.makeCurrent);
		const witness = setupSelectionWitness({
			carId,
			ownerId: c.get('userId'),
			setupId: parentCar.currentSetupId,
			version: parentCar.currentSetupVersion,
		});
		const batchStatements = [
			...(makeCurrent
				? [
						database
							.insert(setup)
							.select(
								database
									.select(setupInsertSelection(value))
									.from(car)
									.where(witness),
							),
					]
				: [database.insert(setup).values(value)]),
			...(makeCurrent
				? [
						database
							.update(car)
							.set({
								currentSetupId: id,
								currentSetupVersion: nextSetupSelectionVersion(),
								currentSetupOperationId: null,
							})
							.where(
								and(
									witness,
									exists(
										database
											.select({ id: setup.id })
											.from(setup)
											.where(eq(setup.id, id)),
									),
								),
							),
					]
				: []),
		] as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]];
		const batch = await database.batch(batchStatements);
		/* c8 ignore next 4 -- D1 affected-row races are covered by production integration tests. */
		if (makeCurrent && (batch[0]?.meta.changes ?? 0) === 0)
			return c.json(
				{ error: 'The Current setup changed while you were editing' },
				409,
			);
		const created = await database
			.select()
			.from(setup)
			.where(eq(setup.id, id))
			.get();
		return c.json(
			{
				setup: publicSetup(
					required(created, 'Created setup could not be loaded'),
					parsed.data.makeCurrent === true,
				),
			},
			201,
		);
	});

	routes.get('/cars/:carId/setups/:setupId', async (c) => {
		const carId = c.req.param('carId');
		const value = await ownedSetup(c, carId, c.req.param('setupId'));
		if (!value) return c.json({ error: 'Setup not found' }, 404);
		const parentCar = await ownedCar(c, carId);
		return c.json({
			setup: publicSetup(value, value.id === parentCar?.currentSetupId),
		});
	});

	routes.post('/cars/:carId/setups/copy', async (c) => {
		const carId = c.req.param('carId');
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWriteSetup(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before copying setups' },
				409,
			);
		const parsed = setupCopyInput.safeParse(
			await c.req.json().catch(() => ({})),
		);
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const candidates = await db(c.env)
			.select()
			.from(setup)
			.where(eq(setup.carId, carId))
			.orderBy(desc(setup.updatedAt), desc(setup.createdAt));
		const source = chooseCopySource(candidates, parentCar.currentSetupId);
		if (!source) return c.json({ error: 'No setup exists to copy' }, 404);
		const value = { ...setupCopyValue(source), ...parsed.data };
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const database = db(c.env);
		const makeCurrent = shouldSelectCurrentSetup(parsed.data.makeCurrent);
		const witness = setupSelectionWitness({
			carId,
			ownerId: c.get('userId'),
			setupId: parentCar.currentSetupId,
			version: parentCar.currentSetupVersion,
		});
		const insertValues = setupInsertValues(id, carId, value, now, source.id);
		const batchStatements = [
			...(makeCurrent
				? [
						database
							.insert(setup)
							.select(
								database
									.select(setupInsertSelection(insertValues))
									.from(car)
									.where(witness),
							),
					]
				: [database.insert(setup).values(insertValues)]),
			...(makeCurrent
				? [
						database
							.update(car)
							.set({
								currentSetupId: id,
								currentSetupVersion: nextSetupSelectionVersion(),
								currentSetupOperationId: null,
							})
							.where(
								and(
									witness,
									exists(
										database
											.select({ id: setup.id })
											.from(setup)
											.where(eq(setup.id, id)),
									),
								),
							),
					]
				: []),
		] as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]];
		const batch = await database.batch(batchStatements);
		/* c8 ignore next 4 -- D1 affected-row races are covered by production integration tests. */
		if (makeCurrent && (batch[0]?.meta.changes ?? 0) === 0)
			return c.json(
				{ error: 'The Current setup changed while you were editing' },
				409,
			);
		const copied = await database
			.select()
			.from(setup)
			.where(eq(setup.id, id))
			.get();
		return c.json(
			{
				setup: publicSetup(
					required(copied, 'Copied setup could not be loaded'),
					parsed.data.makeCurrent === true,
				),
				sourceSetupId: source.id,
			},
			201,
		);
	});

	routes.patch('/cars/:carId/setups/:setupId', async (c) => {
		const carId = c.req.param('carId');
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWriteSetup(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before editing setups' },
				409,
			);
		const existing = await ownedSetup(c, carId, c.req.param('setupId'));
		if (!existing) return c.json({ error: 'Setup not found' }, 404);
		const parsed = setupUpdateInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const value = parsed.data;
		const updateResult = await db(c.env)
			.update(setup)
			.set({
				name: value.name,
				status: value.status,
				setupDate:
					value.setupDate === undefined
						? undefined
						: value.setupDate === null
							? null
							: new Date(value.setupDate).toISOString(),
				track: value.track,
				event: value.event,
				surface: value.surface,
				traction: value.traction,
				moisture: value.moisture,
				condition: value.condition,
				temperature: value.temperature,
				vehicle: jsonText(value.vehicle),
				drivetrain: jsonText(value.drivetrain),
				electronics: jsonText(value.electronics),
				tires: jsonText(value.tires),
				shocks: jsonText(value.shocks),
				frontSuspension: jsonText(value.frontSuspension),
				rearSuspension: jsonText(value.rearSuspension),
				notes: value.notes,
				sourceUrl: value.sourceUrl,
				sourcePdfReference: value.sourcePdfReference,
				sourceMetadata: jsonText(value.sourceMetadata),
				rawValues: jsonText(value.rawValues),
				unmappedValues: jsonText(value.unmappedValues),
				updatedAt: new Date().toISOString(),
				version: existing.version + 1,
				lastOperationId: null,
			})
			.where(
				and(eq(setup.id, existing.id), eq(setup.version, existing.version)),
			)
			.run();
		if (updateResult.meta.changes === 0)
			return c.json({ error: 'The setup changed while you were editing' }, 409);
		const updated = required(
			await ownedSetup(c, carId, existing.id),
			'Updated setup could not be loaded',
		);
		return c.json({
			setup: publicSetup(updated, updated.id === parentCar.currentSetupId),
		});
	});

	routes.post('/cars/:carId/setups/:setupId/copy', async (c) => {
		const carId = c.req.param('carId');
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWriteSetup(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before copying setups' },
				409,
			);
		const source = await ownedSetup(c, carId, c.req.param('setupId'));
		if (!source) return c.json({ error: 'Setup not found' }, 404);
		const parsed = guardedSetupCopyInput.safeParse(
			await c.req.json().catch(() => ({})),
		);
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const sourceValue = setupCopyValue(source);
		const value = { ...sourceValue, ...parsed.data };
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const database = db(c.env);
		const expectedCurrentSetupId = parsed.data.expectedCurrentSetupId;
		const expectedSourceUpdatedAt = parsed.data.expectedSourceUpdatedAt;
		const guardedCurrentSave =
			parsed.data.makeCurrent === true &&
			expectedCurrentSetupId !== undefined &&
			expectedSourceUpdatedAt !== undefined;
		if (guardedCurrentSave && expectedCurrentSetupId !== source.id)
			return c.json(
				{ error: 'The Current setup changed while you were editing' },
				409,
			);
		const insertValues = setupInsertValues(id, carId, value, now, source.id);
		const nextCurrentSetupVersion = nextSetupSelectionVersion();
		if (guardedCurrentSave) {
			const guardedSource = alias(setup, 'guarded_source');
			const batch = await database.batch([
				database.insert(setup).select(
					database
						.select(setupInsertSelection(insertValues))
						.from(car)
						.innerJoin(
							guardedSource,
							and(
								eq(guardedSource.id, source.id),
								eq(guardedSource.carId, carId),
								eq(guardedSource.updatedAt, expectedSourceUpdatedAt),
							),
						)
						.where(
							and(
								eq(car.id, carId),
								eq(car.currentSetupId, expectedCurrentSetupId),
								eq(car.currentSetupVersion, parentCar.currentSetupVersion),
							),
						),
				),
				database
					.update(car)
					.set({
						currentSetupId: id,
						currentSetupVersion: nextCurrentSetupVersion,
						currentSetupOperationId: null,
					})
					.where(
						and(
							setupSelectionWitness({
								carId,
								ownerId: c.get('userId'),
								setupId: expectedCurrentSetupId,
								version: parentCar.currentSetupVersion,
							}),
							exists(
								database
									.select({ id: setup.id })
									.from(setup)
									.where(and(eq(setup.id, id), eq(setup.carId, carId))),
							),
						),
					),
			]);
			/* c8 ignore next 4 -- D1 affected-row races are covered by production integration tests. */
			if ((batch[0]?.meta.changes ?? 0) === 0)
				return c.json(
					{ error: 'The Current setup changed while you were editing' },
					409,
				);
		} else {
			await database.batch([
				database.insert(setup).values(insertValues),
				...(shouldSelectCurrentSetup(parsed.data.makeCurrent)
					? [
							database
								.update(car)
								.set({
									currentSetupId: id,
									currentSetupVersion: nextCurrentSetupVersion,
									currentSetupOperationId: null,
								})
								.where(eq(car.id, carId)),
						]
					: []),
			]);
		}
		const copied = await database
			.select()
			.from(setup)
			.where(eq(setup.id, id))
			.get();
		if (!copied)
			return c.json(
				{ error: 'The Current setup changed while you were editing' },
				409,
			);
		return c.json(
			{
				setup: publicSetup(
					required(copied, 'Copied setup could not be loaded'),
					parsed.data.makeCurrent === true,
				),
			},
			201,
		);
	});

	routes.post('/cars/:carId/setups/:setupId/current', async (c) => {
		const carId = c.req.param('carId');
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWriteSetup(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before selecting a setup' },
				409,
			);
		const value = await ownedSetup(c, carId, c.req.param('setupId'));
		if (!value) return c.json({ error: 'Setup not found' }, 404);
		if (parentCar.currentSetupId !== value.id) {
			const updateResult = await db(c.env)
				.update(car)
				.set({
					currentSetupId: value.id,
					currentSetupVersion: nextSetupSelectionVersion(),
					currentSetupOperationId: null,
				})
				.where(
					setupSelectionWitness({
						carId,
						ownerId: c.get('userId'),
						setupId: parentCar.currentSetupId,
						version: parentCar.currentSetupVersion,
					}),
				)
				.run();
			if (updateResult.meta.changes === 0)
				return c.json(
					{ error: 'The Current setup changed while you were editing' },
					409,
				);
		}
		return c.json({ setup: publicSetup(value, true) });
	});

	return routes;
};
