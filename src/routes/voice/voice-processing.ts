import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDependencies } from '../../app-dependencies';
import { canWrite } from '../../car-policy';
import { db } from '../../db';
import { setup, voiceUpdate } from '../../schema';
import {
	type AppContext,
	type AppEnv,
	voiceCorrectionInput,
	voiceDraftInput,
} from '../../types';
import { VOICE_MAX_BYTES, validateVoiceMetadata } from '../../voice-policy';
import { ownedCar } from '../cars/car-records';
import { jsonValue } from '../json-values';
import {
	correctionRecords,
	ownedVoiceUpdate,
	publicVoiceUpdate,
	voiceResults,
} from './voice-records';

type CorrectionSource = { text?: string; file?: File };

const parseCorrection = async (
	c: AppContext,
): Promise<CorrectionSource | { error: string }> => {
	const contentType = c.req.header('content-type') ?? '';
	if (contentType.startsWith('application/json')) {
		const parsed = voiceCorrectionInput.safeParse(await c.req.json());
		return parsed.success
			? { text: parsed.data.text }
			: { error: 'A correction is required' };
	}
	const body = await c.req.parseBody();
	if (!(body.file instanceof File))
		return { error: 'A correction recording is required' };
	const error = validateVoiceMetadata({
		contentType: body.file.type.toLowerCase(),
		byteSize: body.file.size,
	});
	return error ? { error } : { file: body.file };
};

const contextFor = async (
	c: AppContext,
	value: typeof voiceUpdate.$inferSelect,
) => {
	const parentCar = await ownedCar(c, value.carId);
	if (!parentCar) return undefined;
	const currentSetup = parentCar.currentSetupId
		? await db(c.env)
				.select()
				.from(setup)
				.where(eq(setup.id, parentCar.currentSetupId))
				.get()
		: undefined;
	return {
		parentCar,
		processingContext: {
			carName: parentCar.name,
			driveSessionId: value.driveSessionId ?? undefined,
			currentSetupName: currentSetup?.name,
			currentTrack: currentSetup?.track ?? undefined,
		},
	};
};

const processingFailureMessage = (error: unknown): string =>
	error instanceof Error && error.message.includes('No speech')
		? 'No speech was detected. Try again or use the text fallback.'
		: 'The voice note could not be processed. Your recording is safe; try again.';

export const createVoiceProcessingRoutes = (dependencies: AppDependencies) => {
	const routes = new Hono<AppEnv>();

	routes.post('/voice-updates/:voiceUpdateId/process', async (c) => {
		const existing = await ownedVoiceUpdate(c, c.req.param('voiceUpdateId'));
		if (!existing) return c.json({ error: 'Voice update not found' }, 404);
		if (existing.status === 'saved' || existing.status === 'discarded')
			return c.json(
				{ error: 'This voice update can no longer be processed' },
				409,
			);
		if (existing.status === 'processing')
			return c.json({ voiceUpdate: publicVoiceUpdate(existing) }, 202);
		const context = await contextFor(c, existing);
		if (!context) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(context.parentCar))
			return c.json({ error: 'Archived voice provenance is read-only' }, 409);
		await db(c.env)
			.update(voiceUpdate)
			.set({
				status: 'processing',
				error: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(voiceUpdate.id, existing.id));
		try {
			const object = existing.objectKey
				? await c.env.PHOTOS.get(existing.objectKey)
				: null;
			if (existing.objectKey && !object)
				throw new Error('Stored recording is unavailable');
			const result = await dependencies.voiceProcessor(c.env).process({
				audio: object ? await object.arrayBuffer() : undefined,
				contentType: existing.contentType ?? undefined,
				text: object ? undefined : (existing.transcript ?? undefined),
				context: context.processingContext,
			});
			const draft = voiceDraftInput.parse(result.draft);
			await db(c.env)
				.update(voiceUpdate)
				.set({
					status: 'needs-review',
					transcript: result.transcript,
					draftJson: JSON.stringify(draft),
					clarificationPrompt: result.clarificationPrompt,
					error: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(voiceUpdate.id, existing.id));
		} catch (error) {
			console.error('voice processing failed', {
				voiceUpdateId: existing.id,
				errorName: error instanceof Error ? error.name : 'UnknownError',
			});
			const message = processingFailureMessage(error);
			await db(c.env)
				.update(voiceUpdate)
				.set({
					status: 'failed',
					error: message,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(voiceUpdate.id, existing.id));
			const failed = await ownedVoiceUpdate(c, existing.id);
			return c.json(
				{
					error: message,
					voiceUpdate: failed ? publicVoiceUpdate(failed) : undefined,
				},
				502,
			);
		}
		const updated = await ownedVoiceUpdate(c, existing.id);
		if (!updated) throw new Error('Processed voice update could not be loaded');
		return c.json({ voiceUpdate: publicVoiceUpdate(updated) });
	});

	routes.post('/voice-updates/:voiceUpdateId/corrections', async (c) => {
		const existing = await ownedVoiceUpdate(c, c.req.param('voiceUpdateId'));
		if (!existing) return c.json({ error: 'Voice update not found' }, 404);
		if (existing.status !== 'needs-review' || !existing.transcript)
			return c.json({ error: 'Only a reviewable draft can be corrected' }, 409);
		const draft = voiceDraftInput.safeParse(jsonValue(existing.draftJson));
		if (!draft.success)
			return c.json({ error: 'The current draft is unavailable' }, 409);
		const context = await contextFor(c, existing);
		if (!context) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(context.parentCar))
			return c.json({ error: 'Archived voice provenance is read-only' }, 409);
		const parsed = await parseCorrection(c);
		if ('error' in parsed)
			return c.json({ error: parsed.error, maxBytes: VOICE_MAX_BYTES }, 400);
		const correctionId = crypto.randomUUID();
		const objectKey = parsed.file
			? `voice/${c.get('userId')}/${existing.carId}/${existing.id}/corrections/${correctionId}`
			: undefined;
		if (parsed.file && objectKey)
			await c.env.PHOTOS.put(objectKey, parsed.file.stream(), {
				httpMetadata: { contentType: parsed.file.type.toLowerCase() },
			});
		try {
			const result = await dependencies.voiceProcessor(c.env).process({
				audio: parsed.file ? await parsed.file.arrayBuffer() : undefined,
				contentType: parsed.file?.type.toLowerCase(),
				text: parsed.text,
				context: context.processingContext,
				previous: { transcript: existing.transcript, draft: draft.data },
			});
			const revisedDraft = voiceDraftInput.parse(result.draft);
			const corrections = correctionRecords(existing.correctionsJson);
			corrections.push({
				id: correctionId,
				kind: parsed.file ? 'voice' : 'text',
				transcript: result.transcript,
				objectKey,
				contentType: parsed.file?.type.toLowerCase(),
				byteSize: parsed.file?.size,
				createdAt: new Date().toISOString(),
			});
			await db(c.env)
				.update(voiceUpdate)
				.set({
					draftJson: JSON.stringify(revisedDraft),
					correctionsJson: JSON.stringify(corrections),
					clarificationPrompt: result.clarificationPrompt,
					error: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(voiceUpdate.id, existing.id));
		} catch (error) {
			if (objectKey) await c.env.PHOTOS.delete(objectKey);
			console.error('voice correction failed', {
				voiceUpdateId: existing.id,
				errorName: error instanceof Error ? error.name : 'UnknownError',
			});
			return c.json(
				{
					error:
						'The correction could not be applied. The original draft is unchanged.',
				},
				502,
			);
		}
		const updated = await ownedVoiceUpdate(c, existing.id);
		if (!updated) throw new Error('Corrected voice update could not be loaded');
		return c.json({ voiceUpdate: publicVoiceUpdate(updated) });
	});

	routes.get('/voice-updates/:voiceUpdateId/results', async (c) => {
		const existing = await ownedVoiceUpdate(c, c.req.param('voiceUpdateId'));
		if (!existing) return c.json({ error: 'Voice update not found' }, 404);
		return c.json({
			voiceUpdate: publicVoiceUpdate(
				existing,
				await voiceResults(c, existing.id),
			),
		});
	});

	return routes;
};
