import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { canWrite } from '../../car-policy';
import { db } from '../../db';
import {
	isCompletePhotoOrder,
	normalizePhotoOrder,
	PHOTO_MAX_BYTES,
	photoObjectKey,
} from '../../photo-policy';
import { photo } from '../../schema';
import { type AppEnv, photoReorderInput } from '../../types';
import { ownedCar } from '../cars/car-records';
import { required } from '../invariant';
import { parsePhotoForm, publicPhoto } from './photo-records';

export const createPhotoCollectionRoutes = () => {
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

	return routes;
};
