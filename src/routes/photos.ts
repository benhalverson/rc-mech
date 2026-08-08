import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { canWrite } from '../car-policy';
import { db } from '../db';
import {
	isCompletePhotoOrder,
	normalizePhotoOrder,
	PHOTO_MAX_BYTES,
	photoObjectKey,
	primaryAfterDelete,
} from '../photo-policy';
import { photo } from '../schema';
import {
	AppContext,
	AppEnv,
	photoReorderInput,
	photoUpdateInput,
} from '../types';

import {
	ownedCar,
	ownedPhoto,
	parsePhotoForm,
	publicPhoto,
	required,
} from './shared';

export const createPhotosRoutes = () => {
	const routes = new Hono<AppEnv>();

	routes.get('/cars/:carId/photos', async (c) => {
		const { carId } = c.req.param();
		if (!(await ownedCar(c, carId)))
			return c.json({ error: 'Car not found' }, 404);
		const photos = await db(c.env)
			.select()
			.from(photo)
			.where(eq(photo.carId, carId));
		return c.json({ photos: normalizePhotoOrder(photos).map(publicPhoto) });
	});

	routes.patch('/cars/:carId/photos/reorder', async (c) => {
		const { carId } = c.req.param();
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before reordering photos' },
				409,
			);
		const parsed = photoReorderInput.safeParse(await c.req.json());
		if (!parsed.success)
			return c.json({ error: 'photoIds must be an array of photo IDs' }, 400);
		const database = db(c.env);
		const existing = await database
			.select()
			.from(photo)
			.where(eq(photo.carId, carId));
		if (!isCompletePhotoOrder(existing, parsed.data.photoIds))
			return c.json(
				{ error: 'photoIds must contain every photo exactly once' },
				400,
			);
		if (existing.length > 0) {
			const statements = parsed.data.photoIds.map((photoId, sortOrder) =>
				database
					.update(photo)
					.set({ sortOrder })
					.where(and(eq(photo.id, photoId), eq(photo.carId, carId))),
			);
			await database.batch([
				required(
					statements[0],
					'Complete photo order did not produce an update',
				),
				...statements.slice(1),
			]);
		}
		const reordered = await database
			.select()
			.from(photo)
			.where(eq(photo.carId, carId));
		return c.json({ photos: normalizePhotoOrder(reordered).map(publicPhoto) });
	});

	routes.post('/cars/:carId/photos', async (c) => {
		const { carId } = c.req.param();
		const parentCar = await ownedCar(c, carId);
		if (!parentCar) return c.json({ error: 'Car not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before adding photos' },
				409,
			);
		const parsed = await parsePhotoForm(c);
		if ('error' in parsed)
			return c.json({ error: parsed.error, maxBytes: PHOTO_MAX_BYTES }, 400);
		const database = db(c.env);
		const existing = await database
			.select()
			.from(photo)
			.where(eq(photo.carId, carId));
		const id = crypto.randomUUID();
		const objectKey = photoObjectKey(carId, id);
		const requestedPrimary =
			parsed.primary === 'true' || parsed.primary === '1';
		const sortOrderValue =
			typeof parsed.sortOrder === 'string'
				? Number(parsed.sortOrder)
				: existing.length;
		const sortOrder =
			Number.isInteger(sortOrderValue) &&
			sortOrderValue >= 0 &&
			sortOrderValue <= 10000
				? sortOrderValue
				: undefined;
		if (sortOrder === undefined)
			return c.json({ error: 'sortOrder must be a non-negative integer' }, 400);
		const isPrimary =
			requestedPrimary || !existing.some((value) => value.isPrimary);
		await c.env.PHOTOS.put(objectKey, parsed.file.stream(), {
			httpMetadata: { contentType: parsed.contentType },
		});
		try {
			const insert = database.insert(photo).values({
				id,
				carId,
				objectKey,
				contentType: parsed.contentType,
				fileName: parsed.fileName,
				byteSize: parsed.file.size,
				sortOrder,
				isPrimary,
				createdAt: new Date().toISOString(),
			});
			if (isPrimary) {
				await database.batch([
					database
						.update(photo)
						.set({ isPrimary: false })
						.where(eq(photo.carId, carId)),
					insert,
				]);
			} else {
				await database.batch([insert]);
			}
		} catch (_error) {
			try {
				await c.env.PHOTOS.delete(objectKey);
			} catch (compensationError) {
				console.error('photo upload R2 compensation failed', {
					objectKey,
					compensationError,
				});
			}
			throw _error;
		}
		const created = await database
			.select()
			.from(photo)
			.where(eq(photo.id, id))
			.get();
		return c.json(
			{
				photo: publicPhoto(
					required(created, 'Created photo could not be loaded'),
				),
			},
			201,
		);
	});

	const updatePhoto = async (c: AppContext) => {
		const existing = await ownedPhoto(c, c.req.param('photoId'));
		if (!existing) return c.json({ error: 'Photo not found' }, 404);
		const parentCar = await ownedCar(c, existing.carId);
		if (!parentCar) return c.json({ error: 'Photo not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before editing photos' },
				409,
			);
		const parsed = photoUpdateInput.safeParse(await c.req.json());
		if (!parsed.success)
			return c.json(
				{ error: 'Invalid photo update', details: parsed.error.flatten() },
				400,
			);
		const database = db(c.env);
		const updates =
			parsed.data.sortOrder === undefined
				? {}
				: { sortOrder: parsed.data.sortOrder };
		if (parsed.data.isPrimary === true) {
			await database.batch([
				database
					.update(photo)
					.set({ isPrimary: false })
					.where(eq(photo.carId, existing.carId)),
				database
					.update(photo)
					.set({ ...updates, isPrimary: true })
					.where(eq(photo.id, existing.id)),
			]);
		} else if (parsed.data.isPrimary === false && existing.isPrimary) {
			const others = normalizePhotoOrder(
				(
					await database
						.select()
						.from(photo)
						.where(eq(photo.carId, existing.carId))
				).filter((value) => value.id !== existing.id),
			);
			const replacement = others[0];
			await database.batch([
				database
					.update(photo)
					.set({ ...updates, isPrimary: false })
					.where(eq(photo.id, existing.id)),
				...(replacement
					? [
							database
								.update(photo)
								.set({ isPrimary: true })
								.where(eq(photo.id, replacement.id)),
						]
					: []),
			]);
		} else {
			await database
				.update(photo)
				.set(updates)
				.where(eq(photo.id, existing.id));
		}
		const updated = await database
			.select()
			.from(photo)
			.where(eq(photo.id, existing.id))
			.get();
		return c.json({
			photo: publicPhoto(
				required(updated, 'Updated photo could not be loaded'),
			),
		});
	};
	routes.patch('/photos/:photoId', updatePhoto);

	const replacePhoto = async (c: AppContext) => {
		const existing = await ownedPhoto(c, c.req.param('photoId'));
		if (!existing) return c.json({ error: 'Photo not found' }, 404);
		const parentCar = await ownedCar(c, existing.carId);
		if (!parentCar) return c.json({ error: 'Photo not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before replacing photos' },
				409,
			);
		const parsed = await parsePhotoForm(c);
		if ('error' in parsed)
			return c.json({ error: parsed.error, maxBytes: PHOTO_MAX_BYTES }, 400);
		const previous = await c.env.PHOTOS.get(existing.objectKey);
		const previousBytes = previous ? await previous.arrayBuffer() : undefined;
		await c.env.PHOTOS.put(existing.objectKey, parsed.file.stream(), {
			httpMetadata: { contentType: parsed.contentType },
		});
		let updated: typeof existing;
		try {
			updated = await db(c.env)
				.update(photo)
				.set({
					contentType: parsed.contentType,
					fileName: parsed.fileName,
					byteSize: parsed.file.size,
				})
				.where(eq(photo.id, existing.id))
				.returning()
				.get();
		} catch (error) {
			try {
				if (previousBytes) {
					await c.env.PHOTOS.put(existing.objectKey, previousBytes, {
						httpMetadata: previous?.httpMetadata,
					});
				} else {
					await c.env.PHOTOS.delete(existing.objectKey);
				}
			} catch (compensationError) {
				console.error('photo replace R2 compensation failed', {
					objectKey: existing.objectKey,
					compensationError,
				});
			}
			throw error;
		}
		return c.json({
			photo: publicPhoto(
				required(updated, 'Replaced photo could not be loaded'),
			),
		});
	};

	routes.post('/photos/:photoId/replace', replacePhoto);

	routes.put('/photos/:photoId', async (c) => {
		return replacePhoto(c);
	});

	const deletePhoto = async (c: AppContext) => {
		const existing = await ownedPhoto(c, c.req.param('photoId'));
		if (!existing) return c.json({ error: 'Photo not found' }, 404);
		const parentCar = await ownedCar(c, existing.carId);
		if (!parentCar) return c.json({ error: 'Photo not found' }, 404);
		if (!canWrite(parentCar))
			return c.json(
				{ error: 'Car is archived; restore it before deleting photos' },
				409,
			);
		const database = db(c.env);
		const others = normalizePhotoOrder(
			(
				await database
					.select()
					.from(photo)
					.where(eq(photo.carId, existing.carId))
			).filter((value) => value.id !== existing.id),
		);
		const replacement = existing.isPrimary
			? others.find(
					(value) =>
						value.id === primaryAfterDelete([existing, ...others], existing.id),
				)
			: undefined;
		const previous = await c.env.PHOTOS.get(existing.objectKey);
		const previousBytes = previous ? await previous.arrayBuffer() : undefined;
		try {
			await c.env.PHOTOS.delete(existing.objectKey);
		} catch (_error) {
			return c.json(
				{
					error:
						'Photo storage is temporarily unavailable; nothing was deleted',
				},
				503,
			);
		}
		try {
			await database.batch([
				database.delete(photo).where(eq(photo.id, existing.id)),
				...(replacement
					? [
							database
								.update(photo)
								.set({ isPrimary: true })
								.where(eq(photo.id, replacement.id)),
						]
					: []),
			]);
		} catch (error) {
			try {
				if (previousBytes)
					await c.env.PHOTOS.put(existing.objectKey, previousBytes, {
						httpMetadata: previous?.httpMetadata,
					});
			} catch (compensationError) {
				console.error('photo delete R2 compensation failed', {
					objectKey: existing.objectKey,
					compensationError,
				});
			}
			throw error;
		}
		return c.json({ deleted: true, primaryPhotoId: replacement?.id ?? null });
	};

	routes.delete('/photos/:photoId', deletePhoto);

	routes.get('/photos/:photoId', async (c) => {
		const metadata = await ownedPhoto(c, c.req.param('photoId'));
		if (!metadata) return c.json({ error: 'Photo not found' }, 404);
		const object = await c.env.PHOTOS.get(metadata.objectKey);
		if (!object) return c.json({ error: 'Photo not found' }, 404);
		return new Response(object.body, {
			headers: {
				'Content-Type': metadata.contentType,
				'Content-Length': String(metadata.byteSize),
				'Cache-Control': 'private, max-age=300',
				'Content-Disposition': `inline; filename="${metadata.fileName.replace(/["\\\r\n]/g, '_')}"`,
				'X-Content-Type-Options': 'nosniff',
			},
		});
	});

	// Keep the car-scoped shape used by the car API alongside the photo-id routes.
	const delegateCarPhotoRoute = async (
		c: AppContext,
		handler: (context: AppContext) => Promise<Response>,
	) => {
		const metadata = await ownedPhoto(c, c.req.param('photoId'));
		if (!metadata || metadata.carId !== c.req.param('carId'))
			return c.json({ error: 'Photo not found' }, 404);
		return handler(c);
	};

	routes.patch('/cars/:carId/photos/:photoId', (c) =>
		delegateCarPhotoRoute(c, updatePhoto),
	);
	routes.post('/cars/:carId/photos/:photoId/replace', (c) =>
		delegateCarPhotoRoute(c, replacePhoto),
	);
	routes.delete('/cars/:carId/photos/:photoId', (c) =>
		delegateCarPhotoRoute(c, deletePhoto),
	);

	return routes;
};
