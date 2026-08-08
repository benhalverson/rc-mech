import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { canWrite } from '../../car-policy';
import { db } from '../../db';
import { voiceUpdate } from '../../schema';
import {
	type AppContext,
	type AppEnv,
	voiceCaptureId,
	voiceContextUpdateInput,
	voiceTextCaptureInput,
} from '../../types';
import {
	VOICE_MAX_BYTES,
	validateVoiceMetadata,
	voiceObjectKey,
} from '../../voice-policy';
import { ownedCar } from '../cars/car-records';
import {
	correctionRecords,
	ownedDriveSession,
	ownedVoiceUpdate,
	publicVoiceUpdate,
	voiceResults,
} from './voice-records';

type ParsedCapture = {
	captureId: string;
	driveSessionId: string | null;
	file?: File;
	text?: string;
};

const parseCapture = async (
	c: AppContext,
): Promise<ParsedCapture | { error: string }> => {
	const contentType = c.req.header('content-type') ?? '';
	if (contentType.startsWith('application/json')) {
		const parsed = voiceTextCaptureInput.safeParse(await c.req.json());
		if (!parsed.success) return { error: 'Invalid text voice note' };
		return {
			captureId: parsed.data.captureId,
			driveSessionId: parsed.data.driveSessionId ?? null,
			text: parsed.data.text,
		};
	}
	const body = await c.req.parseBody();
	const id = typeof body.captureId === 'string' ? body.captureId : '';
	const parsedId = voiceCaptureId.safeParse(id);
	if (!parsedId.success) return { error: 'A valid captureId is required' };
	const driveSessionId =
		typeof body.driveSessionId === 'string' && body.driveSessionId.trim()
			? body.driveSessionId
			: null;
	if (!(body.file instanceof File))
		return { error: 'An audio recording is required' };
	const metadataError = validateVoiceMetadata({
		contentType: body.file.type.toLowerCase(),
		byteSize: body.file.size,
	});
	if (metadataError) return { error: metadataError };
	return {
		captureId: parsedId.data,
		driveSessionId,
		file: body.file,
	};
};

const loadPublicVoice = async (c: AppContext, id: string) => {
	const value = await ownedVoiceUpdate(c, id);
	return value
		? publicVoiceUpdate(value, await voiceResults(c, value.id))
		: undefined;
};

export const createVoiceCaptureRoutes = () => {
	const routes = new Hono<AppEnv>();

	routes.get('/cars/:carId/voice-updates', async (c) => {
		const carId = c.req.param('carId');
		if (!(await ownedCar(c, carId)))
			return c.json({ error: 'Car not found' }, 404);
		const values = await db(c.env)
			.select()
			.from(voiceUpdate)
			.where(
				and(
					eq(voiceUpdate.ownerId, c.get('userId')),
					eq(voiceUpdate.carId, carId),
				),
			)
			.orderBy(desc(voiceUpdate.createdAt));
		return c.json({
			voiceUpdates: values.map((value) => publicVoiceUpdate(value)),
		});
	});

	routes.post('/cars/:carId/voice-updates', async (c) => {
		const carId = c.req.param('carId');
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before recording a voice note' },
				409,
			);
		const parsed = await parseCapture(c);
		if ('error' in parsed)
			return c.json({ error: parsed.error, maxBytes: VOICE_MAX_BYTES }, 400);
		const existing = await ownedVoiceUpdate(c, parsed.captureId);
		if (existing) {
			if (existing.carId !== carId)
				return c.json({ error: 'Capture ID is already in use' }, 409);
			return c.json({ voiceUpdate: publicVoiceUpdate(existing) });
		}
		if (
			parsed.driveSessionId &&
			!(await ownedDriveSession(c, carId, parsed.driveSessionId))
		)
			return c.json({ error: 'Drive session not found' }, 404);
		const now = new Date().toISOString();
		const objectKey = parsed.file
			? voiceObjectKey(c.get('userId'), carId, parsed.captureId)
			: null;
		if (parsed.file && objectKey)
			await c.env.PHOTOS.put(objectKey, parsed.file.stream(), {
				httpMetadata: { contentType: parsed.file.type.toLowerCase() },
			});
		try {
			await db(c.env)
				.insert(voiceUpdate)
				.values({
					id: parsed.captureId,
					ownerId: c.get('userId'),
					carId,
					driveSessionId: parsed.driveSessionId,
					objectKey,
					contentType: parsed.file?.type.toLowerCase() ?? null,
					fileName: parsed.file?.name ?? null,
					byteSize: parsed.file?.size ?? 0,
					status: 'pending',
					transcript: parsed.text ?? null,
					draftJson: null,
					correctionsJson: null,
					clarificationPrompt: null,
					error: null,
					confirmedAt: null,
					artifactDeletedAt: null,
					createdAt: now,
					updatedAt: now,
				});
		} catch (error) {
			const raced = await ownedVoiceUpdate(c, parsed.captureId);
			if (raced && raced.carId === carId)
				return c.json({ voiceUpdate: publicVoiceUpdate(raced) });
			if (objectKey) await c.env.PHOTOS.delete(objectKey);
			throw error;
		}
		const created = await ownedVoiceUpdate(c, parsed.captureId);
		if (!created) throw new Error('Created voice update could not be loaded');
		return c.json({ voiceUpdate: publicVoiceUpdate(created) }, 201);
	});

	routes.get('/voice-updates/:voiceUpdateId', async (c) => {
		const value = await loadPublicVoice(c, c.req.param('voiceUpdateId'));
		return value
			? c.json({ voiceUpdate: value })
			: c.json({ error: 'Voice update not found' }, 404);
	});

	routes.get('/voice-updates/:voiceUpdateId/audio', async (c) => {
		const value = await ownedVoiceUpdate(c, c.req.param('voiceUpdateId'));
		if (!value?.objectKey || value.artifactDeletedAt)
			return c.json({ error: 'Recording not found' }, 404);
		const object = await c.env.PHOTOS.get(value.objectKey);
		if (!object) return c.json({ error: 'Recording not found' }, 404);
		return new Response(object.body, {
			headers: {
				'Content-Type': value.contentType ?? 'application/octet-stream',
				'Content-Length': String(value.byteSize),
				'Cache-Control': 'private, no-store',
				'Content-Disposition': `inline; filename="${(value.fileName ?? 'voice-note').replace(/["\\\r\n]/g, '_')}"`,
				'X-Content-Type-Options': 'nosniff',
			},
		});
	});

	routes.get(
		'/voice-updates/:voiceUpdateId/corrections/:correctionId/audio',
		async (c) => {
			const value = await ownedVoiceUpdate(c, c.req.param('voiceUpdateId'));
			if (!value) return c.json({ error: 'Correction not found' }, 404);
			const correction = correctionRecords(value.correctionsJson).find(
				(item) => item.id === c.req.param('correctionId'),
			);
			if (!correction?.objectKey)
				return c.json({ error: 'Correction not found' }, 404);
			const object = await c.env.PHOTOS.get(correction.objectKey);
			if (!object) return c.json({ error: 'Correction not found' }, 404);
			return new Response(object.body, {
				headers: {
					'Content-Type': correction.contentType ?? 'application/octet-stream',
					'Content-Length': String(correction.byteSize ?? object.size),
					'Cache-Control': 'private, no-store',
					'X-Content-Type-Options': 'nosniff',
				},
			});
		},
	);

	routes.patch('/voice-updates/:voiceUpdateId', async (c) => {
		const existing = await ownedVoiceUpdate(c, c.req.param('voiceUpdateId'));
		if (!existing) return c.json({ error: 'Voice update not found' }, 404);
		if (existing.status === 'saved' || existing.status === 'discarded')
			return c.json(
				{ error: 'Saved or discarded voice updates are read-only' },
				409,
			);
		const sourceCar = await ownedCar(c, existing.carId);
		if (!sourceCar || !canWrite(sourceCar))
			return c.json({ error: 'Archived voice provenance is read-only' }, 409);
		const parsed = voiceContextUpdateInput.safeParse(await c.req.json());
		if (!parsed.success)
			return c.json(
				{ error: 'Invalid voice update', details: parsed.error.flatten() },
				400,
			);
		const targetCarId = parsed.data.carId ?? existing.carId;
		const targetCar = await ownedCar(c, targetCarId);
		if (!targetCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(targetCar))
			return c.json({ error: 'Archived voice provenance is read-only' }, 409);
		const driveSessionId =
			parsed.data.driveSessionId === undefined
				? targetCarId === existing.carId
					? existing.driveSessionId
					: null
				: parsed.data.driveSessionId;
		if (
			driveSessionId &&
			!(await ownedDriveSession(c, targetCarId, driveSessionId))
		)
			return c.json({ error: 'Drive session not found' }, 404);
		const corrections = correctionRecords(existing.correctionsJson);
		if (parsed.data.correction)
			corrections.push({
				id: crypto.randomUUID(),
				kind: 'manual',
				transcript: parsed.data.correction,
				createdAt: new Date().toISOString(),
			});
		await db(c.env)
			.update(voiceUpdate)
			.set({
				carId: targetCarId,
				driveSessionId,
				draftJson: parsed.data.draft
					? JSON.stringify(parsed.data.draft)
					: existing.draftJson,
				correctionsJson: corrections.length
					? JSON.stringify(corrections)
					: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(voiceUpdate.id, existing.id));
		const updated = await loadPublicVoice(c, existing.id);
		if (!updated) throw new Error('Updated voice update could not be loaded');
		return c.json({ voiceUpdate: updated });
	});

	routes.delete('/voice-updates/:voiceUpdateId', async (c) => {
		const existing = await ownedVoiceUpdate(c, c.req.param('voiceUpdateId'));
		if (!existing) return c.json({ error: 'Voice update not found' }, 404);
		const parentCar = await ownedCar(c, existing.carId);
		if (!parentCar || !canWrite(parentCar))
			return c.json({ error: 'Archived voice provenance is read-only' }, 409);
		if (existing.objectKey) await c.env.PHOTOS.delete(existing.objectKey);
		const now = new Date().toISOString();
		await db(c.env)
			.update(voiceUpdate)
			.set({
				status: existing.status === 'saved' ? 'saved' : 'discarded',
				objectKey: null,
				contentType: null,
				fileName: null,
				byteSize: 0,
				artifactDeletedAt: now,
				updatedAt: now,
			})
			.where(eq(voiceUpdate.id, existing.id));
		const updated = await loadPublicVoice(c, existing.id);
		if (!updated) throw new Error('Discarded voice update could not be loaded');
		return c.json({ voiceUpdate: updated });
	});

	return routes;
};
