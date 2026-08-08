import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db';
import { car, setup, setupImportDraft } from '../schema';
import {
	defaultImportExtractor,
	resolveSetupImport,
	type SetupImportExtraction,
	sourceKeyFor,
} from '../setup-import-policy';
import {
	canWriteSetup,
	chooseCopySource,
	shouldSelectCurrentSetup,
} from '../setup-policy';
import {
	AppContext,
	AppEnv,
	type SetupInput,
	setupCopyInput,
	setupImportAcceptInput,
	setupImportDraftInput,
	setupImportDraftUpdateInput,
	setupInput,
	setupUpdateInput,
} from '../types';

import {
	draftValues,
	fetchSoDialedSource,
	jsonText,
	jsonValue,
	ownedCar,
	ownedSetup,
	publicImportDraft,
	publicSetup,
	required,
	setupCopyValue,
	setupInsertValues,
} from './shared';

const isUniqueConstraintError = (error: unknown): boolean => {
	let current = error;
	for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
		if (current.message.includes('UNIQUE')) return true;
		current = current.cause;
	}
	return false;
};

export const createSetupsRoutes = () => {
	const routes = new Hono<AppEnv>();

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
		await database.batch([
			database.insert(setup).values(value),
			...(shouldSelectCurrentSetup(parsed.data.makeCurrent)
				? [
						database
							.update(car)
							.set({ currentSetupId: id })
							.where(eq(car.id, carId)),
					]
				: []),
		]);
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
		await database.batch([
			database
				.insert(setup)
				.values(setupInsertValues(id, carId, value, now, source.id)),
			...(shouldSelectCurrentSetup(parsed.data.makeCurrent)
				? [
						database
							.update(car)
							.set({ currentSetupId: id })
							.where(eq(car.id, carId)),
					]
				: []),
		]);
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
		await db(c.env)
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
			})
			.where(eq(setup.id, existing.id));
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
		const parsed = setupCopyInput.safeParse(
			await c.req.json().catch(() => ({})),
		);
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const sourceValue = setupCopyValue(source);
		const value = { ...sourceValue, ...parsed.data };
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const database = db(c.env);
		await database.batch([
			database
				.insert(setup)
				.values(setupInsertValues(id, carId, value, now, source.id)),
			...(shouldSelectCurrentSetup(parsed.data.makeCurrent)
				? [
						database
							.update(car)
							.set({ currentSetupId: id })
							.where(eq(car.id, carId)),
					]
				: []),
		]);
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
		await db(c.env)
			.update(car)
			.set({ currentSetupId: value.id })
			.where(eq(car.id, carId));
		return c.json({ setup: publicSetup(value, true) });
	});

	const ownedImportDraft = async (c: AppContext, draftId: string) =>
		db(c.env)
			.select()
			.from(setupImportDraft)
			.where(
				and(
					eq(setupImportDraft.id, draftId),
					eq(setupImportDraft.ownerId, c.get('userId')),
				),
			)
			.get();

	const ownedImportedSetup = async (c: AppContext, sourceKey: string) => {
		const candidates = await db(c.env)
			.select()
			.from(setup)
			.where(eq(setup.sourceUrl, sourceKey));
		for (const candidate of candidates) {
			if (await ownedCar(c, candidate.carId)) return candidate;
		}
		return undefined;
	};

	const draftSetupInput = (
		draft: typeof setupImportDraft.$inferSelect,
		name?: string,
	): SetupInput => {
		const known = jsonValue(draft.knownValues);
		const raw = jsonValue(draft.rawValues);
		const uncertain = jsonValue(draft.uncertainValues);
		const unmapped = jsonValue(draft.unmappedValues);
		const identity = jsonValue(draft.sourceIdentity);
		const candidate = {
			...(known && typeof known === 'object' ? known : {}),
			name:
				name ??
				(identity && typeof identity === 'object' && 'title' in identity
					? String(identity.title)
					: 'Imported setup'),
			status: 'reviewed' as const,
			sourceUrl: draft.sourceUrl,
			sourcePdfReference: draft.sourcePdfReference ?? undefined,
			sourceMetadata:
				(jsonValue(draft.sourceMetadata) as Record<string, unknown> | null) ??
				undefined,
			rawValues: {
				...(raw && typeof raw === 'object' ? raw : {}),
				uncertainValues: uncertain ?? {},
			},
			unmappedValues:
				unmapped && typeof unmapped === 'object'
					? (unmapped as Record<string, unknown>)
					: {},
		};
		const parsed = setupInput.safeParse(candidate);
		if (parsed.success) return parsed.data;
		return {
			name: candidate.name,
			status: 'reviewed',
			sourceUrl: draft.sourceUrl,
			sourcePdfReference: draft.sourcePdfReference ?? undefined,
			sourceMetadata:
				(jsonValue(draft.sourceMetadata) as Record<string, unknown> | null) ??
				undefined,
			rawValues: candidate.rawValues as Record<string, unknown>,
			unmappedValues: candidate.unmappedValues as Record<string, unknown>,
		};
	};

	routes.post('/setup-imports/drafts', async (c) => {
		const parsed = setupImportDraftInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		// setupImportDraftInput and sourceKeyFor intentionally share the same URL
		// policy, so a successfully parsed value always has a canonical key.
		const sourceKey = required(
			sourceKeyFor(parsed.data.sourceUrl),
			'Validated So Dialed setup URL did not have a canonical key',
		);
		if (parsed.data.carId && !(await ownedCar(c, parsed.data.carId)))
			return c.json({ error: 'Car not found' }, 404);
		const existingSetup = await ownedImportedSetup(c, sourceKey);
		const existingDraft = await db(c.env)
			.select()
			.from(setupImportDraft)
			.where(
				and(
					eq(setupImportDraft.ownerId, c.get('userId')),
					eq(setupImportDraft.sourceKey, sourceKey),
					eq(setupImportDraft.status, 'draft'),
				),
			)
			.get();
		if (existingSetup || existingDraft)
			return c.json(
				{
					error: 'Source has already been imported',
					existingSetupId: existingSetup?.id ?? null,
					draft: existingDraft ? publicImportDraft(existingDraft) : null,
				},
				409,
			);

		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		let extraction: SetupImportExtraction;
		try {
			const resolved = await resolveSetupImport(
				sourceKey,
				fetchSoDialedSource,
				defaultImportExtractor,
			);
			extraction = resolved;
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Source unavailable';
			await db(c.env)
				.insert(setupImportDraft)
				.values({
					id,
					ownerId: c.get('userId'),
					carId: parsed.data.carId ?? null,
					sourceUrl: sourceKey,
					sourceKey,
					status: 'error',
					error: message,
					createdAt: now,
					updatedAt: now,
				});
			const draft = await ownedImportDraft(c, id);
			return c.json(
				{
					error: message,
					draft: publicImportDraft(
						required(draft, 'Import draft could not be loaded'),
					),
				},
				422,
			);
		}
		try {
			await db(c.env)
				.insert(setupImportDraft)
				.values({
					id,
					ownerId: c.get('userId'),
					carId: parsed.data.carId ?? null,
					sourceUrl: sourceKey,
					sourceKey,
					status: 'draft',
					...draftValues(extraction),
					createdAt: now,
					updatedAt: now,
				});
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			const concurrent = await db(c.env)
				.select()
				.from(setupImportDraft)
				.where(
					and(
						eq(setupImportDraft.ownerId, c.get('userId')),
						eq(setupImportDraft.sourceKey, sourceKey),
						eq(setupImportDraft.status, 'draft'),
					),
				)
				.get();
			return c.json(
				{
					error: 'An open draft already exists for this source',
					draft: concurrent ? publicImportDraft(concurrent) : null,
				},
				409,
			);
		}
		const draft = await ownedImportDraft(c, id);
		return c.json(
			{
				draft: publicImportDraft(
					required(draft, 'Import draft could not be loaded'),
				),
			},
			201,
		);
	});

	routes.get('/setup-imports/drafts', async (c) => {
		const drafts = await db(c.env)
			.select()
			.from(setupImportDraft)
			.where(eq(setupImportDraft.ownerId, c.get('userId')))
			.orderBy(desc(setupImportDraft.updatedAt));
		return c.json({ drafts: drafts.map(publicImportDraft) });
	});

	routes.get('/setup-imports/drafts/:draftId', async (c) => {
		const draft = await ownedImportDraft(c, c.req.param('draftId'));
		if (!draft) return c.json({ error: 'Import draft not found' }, 404);
		return c.json({ draft: publicImportDraft(draft) });
	});

	routes.patch('/setup-imports/drafts/:draftId', async (c) => {
		const draft = await ownedImportDraft(c, c.req.param('draftId'));
		if (!draft) return c.json({ error: 'Import draft not found' }, 404);
		if (draft.status !== 'draft')
			return c.json({ error: 'Only an open import draft can be edited' }, 409);
		const parsed = setupImportDraftUpdateInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		if (parsed.data.carId && !(await ownedCar(c, parsed.data.carId)))
			return c.json({ error: 'Car not found' }, 404);
		const value = parsed.data;
		await db(c.env)
			.update(setupImportDraft)
			.set({
				carId: value.carId === undefined ? undefined : value.carId,
				knownValues: jsonText(value.knownValues),
				uncertainValues: jsonText(value.uncertainValues),
				rawValues: jsonText(value.rawValues),
				unmappedValues: jsonText(value.unmappedValues),
				sourceMetadata: jsonText(value.sourceMetadata),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(setupImportDraft.id, draft.id));
		const updated = await ownedImportDraft(c, draft.id);
		return c.json({
			draft: publicImportDraft(
				required(updated, 'Import draft could not be loaded'),
			),
		});
	});

	routes.post('/setup-imports/drafts/:draftId/cancel', async (c) => {
		const draft = await ownedImportDraft(c, c.req.param('draftId'));
		if (!draft) return c.json({ error: 'Import draft not found' }, 404);
		if (draft.status !== 'draft' && draft.status !== 'error')
			return c.json({ error: 'Import draft is already closed' }, 409);
		await db(c.env)
			.update(setupImportDraft)
			.set({ status: 'cancelled', updatedAt: new Date().toISOString() })
			.where(eq(setupImportDraft.id, draft.id));
		return c.json({ ok: true });
	});

	routes.post('/setup-imports/drafts/:draftId/accept', async (c) => {
		const draft = await ownedImportDraft(c, c.req.param('draftId'));
		if (!draft) return c.json({ error: 'Import draft not found' }, 404);
		if (draft.status !== 'draft')
			return c.json(
				{ error: 'Only an open import draft can be accepted' },
				409,
			);
		const parsed = setupImportAcceptInput.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const parentCar = await ownedCar(c, parsed.data.carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWriteSetup(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before accepting imports' },
				409,
			);
		const sourceSetup = await ownedImportedSetup(c, draft.sourceKey);
		if (sourceSetup)
			return c.json(
				{
					error: 'Source has already been imported',
					existingSetupId: sourceSetup.id,
				},
				409,
			);
		const setupId = crypto.randomUUID();
		const now = new Date().toISOString();
		const value = draftSetupInput(draft, parsed.data.name);
		const database = db(c.env);
		await database.batch([
			database
				.insert(setup)
				.values(setupInsertValues(setupId, parsed.data.carId, value, now)),
			database
				.update(setupImportDraft)
				.set({
					status: 'accepted',
					acceptedSetupId: setupId,
					carId: parsed.data.carId,
					updatedAt: now,
				})
				.where(eq(setupImportDraft.id, draft.id)),
			...(shouldSelectCurrentSetup(parsed.data.makeCurrent)
				? [
						database
							.update(car)
							.set({ currentSetupId: setupId })
							.where(eq(car.id, parsed.data.carId)),
					]
				: []),
		]);
		const created = await database
			.select()
			.from(setup)
			.where(eq(setup.id, setupId))
			.get();
		return c.json(
			{
				setup: publicSetup(
					required(created, 'Imported setup could not be loaded'),
				),
			},
			201,
		);
	});

	return routes;
};
