import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../../db';
import { car, setup, setupImportDraft } from '../../schema';
import {
	defaultImportExtractor,
	resolveSetupImport,
	type SetupImportExtraction,
	sourceKeyFor,
} from '../../setup-import-policy';
import { canWriteSetup, shouldSelectCurrentSetup } from '../../setup-policy';
import {
	type AppContext,
	type AppEnv,
	setupImportAcceptInput,
	setupImportDraftInput,
	setupImportDraftUpdateInput,
} from '../../types';
import { ownedCar } from '../cars/car-records';
import { required } from '../invariant';
import { jsonText } from '../json-values';
import {
	draftSetupInput,
	draftValues,
	isUniqueConstraintError,
	publicImportDraft,
} from './import-records';
import { fetchSoDialedSource } from './import-source';
import { publicSetup, setupInsertValues } from './setup-records';

export const createSetupImportRoutes = () => {
	const routes = new Hono<AppEnv>();

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
