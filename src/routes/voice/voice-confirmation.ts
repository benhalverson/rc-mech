import { desc, eq } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Hono } from 'hono';
import { canWrite } from '../../car-policy';
import { db } from '../../db';
import {
	car,
	consumableMaintenanceEntry,
	driveSession,
	setup,
	voiceProblemNote,
	voiceUpdate,
	voiceUpdateResult,
} from '../../schema';
import {
	type AppContext,
	type AppEnv,
	consumableInput,
	type SetupInput,
	voiceConfirmInput,
	voiceDraftInput,
} from '../../types';
import { ownedCar } from '../cars/car-records';
import { jsonValue } from '../json-values';
import { consumableInsertValues } from '../maintenance/consumable-records';
import { setupCopyValue, setupInsertValues } from '../setups/setup-records';
import {
	ownedDriveSession,
	ownedVoiceUpdate,
	publicVoiceUpdate,
	voiceResults,
} from './voice-records';

type ResultValue = {
	id: string;
	voiceUpdateId: string;
	kind: 'setup' | 'drive-session' | 'problem-note' | 'consumable';
	recordId: string;
	label: string;
	createdAt: string;
};

const appendText = (
	existing: string | null | undefined,
	values: string[],
	separator = '\n',
): string | null => {
	const additions = values.map((value) => value.trim()).filter(Boolean);
	return (
		[existing?.trim(), ...additions].filter(Boolean).join(separator) || null
	);
};

const contextField = (
	value: SetupInput,
	field: string,
	next: string,
): boolean => {
	switch (field) {
		case 'track':
		case 'event':
		case 'surface':
		case 'traction':
		case 'moisture':
		case 'condition':
		case 'temperature':
			value[field] = next;
			return true;
		default:
			return false;
	}
};

const latestSetup = async (
	c: AppContext,
	carId: string,
	currentSetupId: string | null,
) => {
	if (currentSetupId) {
		const current = await db(c.env)
			.select()
			.from(setup)
			.where(eq(setup.id, currentSetupId))
			.get();
		if (current?.carId === carId) return current;
	}
	return db(c.env)
		.select()
		.from(setup)
		.where(eq(setup.carId, carId))
		.orderBy(desc(setup.createdAt))
		.get();
};

const unresolvedFacts = (
	draft: ReturnType<typeof voiceDraftInput.parse>,
): string[] => [
	...draft.setupChanges
		.filter((item) => item.needsReview)
		.map((item) => item.sourceText),
	...draft.problems
		.filter((item) => item.needsReview)
		.map((item) => item.sourceText),
	...draft.conditions
		.filter((item) => item.needsReview)
		.map((item) => item.sourceText),
	...draft.driveSessionNotes
		.filter((item) => item.needsReview)
		.map((item) => item.sourceText),
	...draft.consumables
		.filter((item) => item.needsReview)
		.map((item) => item.sourceText),
	...draft.unresolvedNotes,
];

const resultValue = (
	voiceUpdateId: string,
	kind: ResultValue['kind'],
	recordId: string,
	label: string,
	now: string,
	sequence: number,
): ResultValue => ({
	id: `${voiceUpdateId}:result:${sequence}`,
	voiceUpdateId,
	kind,
	recordId,
	label,
	createdAt: now,
});

export const createVoiceConfirmationRoutes = () => {
	const routes = new Hono<AppEnv>();

	routes.post('/voice-updates/:voiceUpdateId/confirm', async (c) => {
		const existing = await ownedVoiceUpdate(c, c.req.param('voiceUpdateId'));
		if (!existing) return c.json({ error: 'Voice update not found' }, 404);
		if (existing.status === 'saved')
			return c.json({
				voiceUpdate: publicVoiceUpdate(
					existing,
					await voiceResults(c, existing.id),
				),
			});
		if (existing.status !== 'needs-review')
			return c.json(
				{ error: 'Review the processed draft before saving it' },
				409,
			);
		const parentCar = await ownedCar(c, existing.carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json({ error: 'Archived voice provenance is read-only' }, 409);
		const parsedBody = voiceConfirmInput.safeParse(await c.req.json());
		if (!parsedBody.success)
			return c.json({ error: 'Invalid voice confirmation' }, 400);
		const parsedDraft = voiceDraftInput.safeParse(
			jsonValue(existing.draftJson),
		);
		if (!parsedDraft.success)
			return c.json({ error: 'The review draft is unavailable' }, 409);
		const draft = parsedDraft.data;
		const unresolved = unresolvedFacts(draft);
		if (unresolved.length && !parsedBody.data.acceptUnresolvedAsNotes)
			return c.json(
				{
					error: 'Resolve uncertain values or explicitly keep them as notes',
					needsReview: unresolved.length,
				},
				409,
			);
		const now = new Date().toISOString();
		const database = db(c.env);
		const statements: BatchItem<'sqlite'>[] = [];
		const results: ResultValue[] = [];
		let resultSequence = 0;
		let resultingSetupId = parentCar.currentSetupId;

		const confirmedSetupChanges = draft.setupChanges.filter(
			(item) => !item.needsReview,
		);
		const confirmedConditions = draft.conditions.filter(
			(item) => !item.needsReview,
		);
		if (confirmedSetupChanges.length || confirmedConditions.length) {
			const source = await latestSetup(
				c,
				parentCar.id,
				parentCar.currentSetupId,
			);
			const next: SetupInput = source
				? setupCopyValue(source)
				: { name: `Voice update ${existing.createdAt.slice(0, 10)}` };
			next.name = `${source?.name ?? 'Track setup'} · voice update`.slice(
				0,
				160,
			);
			next.status = 'active';
			next.setupDate = existing.createdAt;
			const extraNotes: string[] = [];
			for (const condition of confirmedConditions)
				contextField(next, condition.field, condition.value);
			for (const change of confirmedSetupChanges) {
				const nextValue = String(change.value);
				if (change.section === 'context') {
					if (!contextField(next, change.field, nextValue))
						extraNotes.push(`${change.field}: ${nextValue}`);
					continue;
				}
				const section = next[change.section] ?? {};
				next[change.section] = { ...section, [change.field]: change.value };
			}
			next.notes = appendText(next.notes, extraNotes);
			next.sourceMetadata = {
				...(next.sourceMetadata ?? {}),
				voiceUpdateId: existing.id,
			};
			const setupId = `${existing.id}:setup`;
			resultingSetupId = setupId;
			statements.push(
				database
					.insert(setup)
					.values(
						setupInsertValues(
							setupId,
							parentCar.id,
							next,
							now,
							source?.id ?? null,
						),
					),
				database
					.update(car)
					.set({
						currentSetupId: setupId,
						currentSetupVersion: parentCar.currentSetupVersion + 1,
						currentSetupOperationId: null,
					})
					.where(eq(car.id, parentCar.id)),
			);
			results.push(
				resultValue(
					existing.id,
					'setup',
					setupId,
					'New setup snapshot',
					now,
					resultSequence++,
				),
			);
		}

		const confirmedProblems = draft.problems.filter(
			(item) => !item.needsReview,
		);
		const confirmedDriveNotes = draft.driveSessionNotes.filter(
			(item) => !item.needsReview,
		);
		const runNotes = [
			...confirmedDriveNotes.map((item) => item.text),
			...confirmedProblems.map((item) => `Problem: ${item.text}`),
			...draft.unmappedNotes,
			...(parsedBody.data.acceptUnresolvedAsNotes ? unresolved : []),
		];
		const runConditions = confirmedConditions.map(
			(item) => `${item.field}: ${item.value}`,
		);
		let driveSessionId = existing.driveSessionId;
		if (driveSessionId) {
			const run = await ownedDriveSession(c, parentCar.id, driveSessionId);
			if (!run || run.deletedAt)
				return c.json({ error: 'Selected drive session is unavailable' }, 409);
			if (runNotes.length || runConditions.length)
				statements.push(
					database
						.update(driveSession)
						.set({
							notes: appendText(run.notes, runNotes),
							conditions: appendText(run.conditions, runConditions, ' · '),
						})
						.where(eq(driveSession.id, driveSessionId)),
				);
		} else if (runNotes.length || runConditions.length) {
			driveSessionId = `${existing.id}:drive`;
			statements.push(
				database.insert(driveSession).values({
					id: driveSessionId,
					carId: parentCar.id,
					startedAt: existing.createdAt,
					durationMinutes: null,
					conditions: appendText(null, runConditions, ' · '),
					notes: appendText(null, runNotes),
					deletedAt: null,
				}),
			);
		}
		if (driveSessionId && (runNotes.length || runConditions.length))
			results.push(
				resultValue(
					existing.id,
					'drive-session',
					driveSessionId,
					'Drive-session history',
					now,
					resultSequence++,
				),
			);

		const problemTexts = [
			...confirmedProblems.map((item) => item.text),
			...draft.unmappedNotes,
			...(parsedBody.data.acceptUnresolvedAsNotes ? unresolved : []),
		];
		for (const [index, note] of problemTexts.entries()) {
			const noteId = `${existing.id}:problem:${index}`;
			statements.push(
				database.insert(voiceProblemNote).values({
					id: noteId,
					voiceUpdateId: existing.id,
					carId: parentCar.id,
					driveSessionId,
					note,
					createdAt: now,
				}),
			);
			results.push(
				resultValue(
					existing.id,
					'problem-note',
					noteId,
					'Problem or free-form note',
					now,
					resultSequence++,
				),
			);
		}

		for (const [index, item] of draft.consumables
			.filter((value) => !value.needsReview)
			.entries()) {
			const entryId = `${existing.id}:consumable:${index}`;
			const input = consumableInput.parse(
				item.kind === 'tires'
					? {
							kind: 'tires',
							performedAt: existing.createdAt,
							front:
								item.axle === 'front' || item.axle === 'both'
									? { details: item.details ?? item.sourceText }
									: undefined,
							rear:
								item.axle === 'rear' || item.axle === 'both'
									? { details: item.details ?? item.sourceText }
									: undefined,
							notes: item.notes,
						}
					: {
							kind: 'fluid',
							performedAt: existing.createdAt,
							fluidArea: item.fluidArea,
							customFluidArea: item.customFluidArea,
							notes: item.notes ?? item.details ?? item.sourceText,
						},
			);
			statements.push(
				database
					.insert(consumableMaintenanceEntry)
					.values(
						consumableInsertValues(
							entryId,
							parentCar.id,
							input,
							now,
							resultingSetupId,
						),
					),
			);
			results.push(
				resultValue(
					existing.id,
					'consumable',
					entryId,
					item.kind === 'tires' ? 'Tire-set maintenance' : 'Fluid maintenance',
					now,
					resultSequence++,
				),
			);
		}

		for (const result of results)
			statements.push(database.insert(voiceUpdateResult).values(result));
		const confirmation = database
			.update(voiceUpdate)
			.set({
				status: 'saved',
				driveSessionId,
				confirmedAt: now,
				error: null,
				updatedAt: now,
			})
			.where(eq(voiceUpdate.id, existing.id));
		const batchStatements: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
			confirmation,
		];
		batchStatements.unshift(...statements);
		try {
			await database.batch(batchStatements);
		} catch (error) {
			const raced = await ownedVoiceUpdate(c, existing.id);
			if (raced?.status !== 'saved') throw error;
		}
		const saved = await ownedVoiceUpdate(c, existing.id);
		if (!saved) throw new Error('Saved voice update could not be loaded');
		return c.json({
			voiceUpdate: publicVoiceUpdate(saved, await voiceResults(c, saved.id)),
		});
	});

	return routes;
};
