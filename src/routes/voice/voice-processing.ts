import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDependencies } from '../../app-dependencies';
import { canWrite } from '../../car-policy';
import { db } from '../../db';
import { setup, voiceUpdate } from '../../schema';
import {
	type AppContext,
	type AppEnv,
	VOICE_CORRECTION_MAX_LENGTH,
	voiceCorrectionInput,
	voiceDraftInput,
} from '../../types';
import { VOICE_MAX_BYTES, validateVoiceMetadata } from '../../voice-policy';
import {
	isNoSpeechProcessingError,
	VoiceProcessingError,
} from '../../voice-processing';
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
			: {
					error: `Type a correction of ${VOICE_CORRECTION_MAX_LENGTH.toLocaleString('en-US')} characters or fewer`,
				};
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
	isNoSpeechProcessingError(error)
		? 'No speech was detected. Try again or use the text fallback.'
		: 'The voice note could not be processed. Your recording is safe; try again.';

const processingFailureStatus = (error: unknown): 422 | 502 =>
	isNoSpeechProcessingError(error) ? 422 : 502;

const correctionFailureMessage = (error: unknown): string =>
	isNoSpeechProcessingError(error)
		? 'No speech was detected in the correction. The original draft is unchanged; try again or use the text fallback.'
		: 'The correction could not be applied. The original draft is unchanged.';

const processingFailureMetadata = (
	error: unknown,
	fallbackStage: 'storage' | 'processing' | 'validation' | 'persistence',
) => ({
	stage: error instanceof VoiceProcessingError ? error.stage : fallbackStage,
	errorName: error instanceof Error ? error.name : 'UnknownError',
	attemptCount: error instanceof VoiceProcessingError ? error.attemptCount : 1,
});

const isCorrectionAiFailure = (
	error: unknown,
	stage: 'storage' | 'processing' | 'validation' | 'persistence',
): boolean => {
	const effectiveStage =
		error instanceof VoiceProcessingError ? error.stage : stage;
	return effectiveStage === 'extraction' || effectiveStage === 'validation';
};

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
		let failureStage: 'storage' | 'processing' | 'validation' | 'persistence' =
			'storage';
		try {
			const object = existing.objectKey
				? await c.env.PHOTOS.get(existing.objectKey)
				: null;
			if (existing.objectKey && !object)
				throw new Error('Stored recording is unavailable');
			failureStage = 'processing';
			const result = await dependencies.voiceProcessor(c.env).process({
				audio: object ? await object.arrayBuffer() : undefined,
				contentType: existing.contentType ?? undefined,
				text: object ? undefined : (existing.transcript ?? undefined),
				context: context.processingContext,
			});
			failureStage = 'validation';
			const draft = voiceDraftInput.parse(result.draft);
			failureStage = 'persistence';
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
				...processingFailureMetadata(error, failureStage),
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
				processingFailureStatus(error),
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
			return c.json(
				{
					error: parsed.error,
					maxBytes: VOICE_MAX_BYTES,
					maxCharacters: VOICE_CORRECTION_MAX_LENGTH,
				},
				400,
			);
		const correctionText = parsed.text?.trim();
		const previousCorrections = correctionRecords(existing.correctionsJson);
		if (
			correctionText &&
			previousCorrections.some(
				(correction) =>
					correction.kind === 'manual' &&
					correction.transcript === correctionText,
			)
		) {
			return c.json({
				voiceUpdate: publicVoiceUpdate(existing),
				correction: { outcome: 'manual-note' as const },
			});
		}
		const correctionId = crypto.randomUUID();
		const objectKey = parsed.file
			? `voice/${c.get('userId')}/${existing.carId}/${existing.id}/corrections/${correctionId}`
			: undefined;
		if (parsed.file && objectKey)
			await c.env.PHOTOS.put(objectKey, parsed.file.stream(), {
				httpMetadata: { contentType: parsed.file.type.toLowerCase() },
			});
		let failureStage: 'storage' | 'processing' | 'validation' | 'persistence' =
			'storage';
		let outcome: 'ai-draft' | 'manual-note' = 'ai-draft';
		try {
			failureStage = 'processing';
			const result = await dependencies.voiceProcessor(c.env).process({
				audio: parsed.file ? await parsed.file.arrayBuffer() : undefined,
				contentType: parsed.file?.type.toLowerCase(),
				text: parsed.text,
				context: context.processingContext,
				previous: { transcript: existing.transcript, draft: draft.data },
			});
			failureStage = 'validation';
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
			failureStage = 'persistence';
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
			if (correctionText && isCorrectionAiFailure(error, failureStage)) {
				const aiFailureMetadata = processingFailureMetadata(
					error,
					failureStage,
				);
				try {
					const manualDraft = voiceDraftInput.parse({
						...draft.data,
						unmappedNotes: draft.data.unmappedNotes.includes(correctionText)
							? draft.data.unmappedNotes
							: [...draft.data.unmappedNotes, correctionText],
					});
					const corrections = correctionRecords(existing.correctionsJson);
					corrections.push({
						id: correctionId,
						kind: 'manual',
						transcript: correctionText,
						createdAt: new Date().toISOString(),
					});
					failureStage = 'persistence';
					await db(c.env)
						.update(voiceUpdate)
						.set({
							draftJson: JSON.stringify(manualDraft),
							correctionsJson: JSON.stringify(corrections),
							error: null,
							updatedAt: new Date().toISOString(),
						})
						.where(eq(voiceUpdate.id, existing.id));
					outcome = 'manual-note';
					console.warn('voice correction used manual fallback', {
						voiceUpdateId: existing.id,
						...aiFailureMetadata,
					});
				} catch (fallbackError) {
					console.error('voice correction failed', {
						voiceUpdateId: existing.id,
						...processingFailureMetadata(fallbackError, 'persistence'),
					});
					return c.json(
						{ error: correctionFailureMessage(fallbackError) },
						502,
					);
				}
			} else {
				if (objectKey) await c.env.PHOTOS.delete(objectKey);
				console.error('voice correction failed', {
					voiceUpdateId: existing.id,
					...processingFailureMetadata(error, failureStage),
				});
				return c.json(
					{
						error: correctionFailureMessage(error),
					},
					processingFailureStatus(error),
				);
			}
		}
		const updated = await ownedVoiceUpdate(c, existing.id);
		if (!updated) throw new Error('Corrected voice update could not be loaded');
		return c.json({
			voiceUpdate: publicVoiceUpdate(updated),
			correction: { outcome },
		});
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
