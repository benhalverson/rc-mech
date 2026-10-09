import { and, eq, exists, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { canWrite } from '../../car-policy';
import { db } from '../../db';
import { photoObjectKey } from '../../photo-policy';
import { car, photo, syncOperation } from '../../schema';
import type { AppEnv } from '../../types';
import { ownedCar } from '../cars/car-records';
import { parsePhotoForm, publicPhoto } from './photo-records';

export const createPhotoCaptureRoutes = () => {
	const routes = new Hono<AppEnv>();
	routes.onError(
		() =>
			new Response(
				JSON.stringify({
					error: 'Photo capture synchronization is temporarily unavailable.',
				}),
				{ status: 503, headers: { 'content-type': 'application/json' } },
			),
	);
	routes.put('/cars/:carId/photos/captures/:operationId', async (c) => {
		const operation = z.uuid().safeParse(c.req.param('operationId'));
		const carIdentity = z.uuid().safeParse(c.req.param('carId'));
		if (!operation.success || !carIdentity.success)
			return c.json({ error: 'Invalid photo capture identity.' }, 400);
		const operationId = operation.data;
		const carId = carIdentity.data;
		const ownerId = c.get('userId');
		const parsed = await parsePhotoForm(c);
		if ('error' in parsed) return c.json({ error: parsed.error }, 422);
		const bytes = await parsed.file.arrayBuffer();
		const digest = async (value: ArrayBuffer | Uint8Array) =>
			[...new Uint8Array(await crypto.subtle.digest('SHA-256', value))]
				.map((byte) => byte.toString(16).padStart(2, '0'))
				.join('');
		const requestHash = await digest(
			new TextEncoder().encode(
				JSON.stringify({
					carId,
					fileName: parsed.fileName,
					contentType: parsed.contentType,
					digest: await digest(bytes),
				}),
			),
		);
		const database = db(c.env);
		const now = new Date().toISOString();
		const identity = and(
			eq(syncOperation.ownerId, ownerId),
			eq(syncOperation.operationId, operationId),
		);
		const read = () =>
			database.select().from(syncOperation).where(identity).get();
		const reply = (receipt: typeof syncOperation.$inferSelect | undefined) => {
			if (
				!receipt ||
				receipt.outcome === 'pending' ||
				receipt.httpStatus === null ||
				receipt.responseJson === null
			)
				throw new Error('Capture receipt is pending.');
			return new Response(receipt.responseJson, {
				status: receipt.httpStatus,
				headers: { 'content-type': 'application/json' },
			});
		};
		const claimed = await database
			.insert(syncOperation)
			.values({
				ownerId,
				operationId,
				contractVersion: 1,
				kind: 'photo.capture',
				entityType: 'photo',
				entityId: operationId,
				requestHash,
				outcome: 'pending',
				createdAt: now,
			})
			.onConflictDoNothing()
			.returning()
			.get();
		const receipt = claimed ?? (await read());
		if (!receipt)
			return c.json({ error: 'Photo capture is being synchronized.' }, 503);
		if (receipt.requestHash !== requestHash)
			return c.json(
				{
					error:
						'Photo capture identity was already used for different content.',
				},
				409,
			);
		if (receipt.outcome !== 'pending') return reply(receipt);
		const pending = and(
			identity,
			eq(syncOperation.requestHash, requestHash),
			eq(syncOperation.outcome, 'pending'),
		);
		const reject = async (error: string) => {
			await database
				.update(syncOperation)
				.set({
					outcome: 'rejected',
					httpStatus: 409,
					responseJson: JSON.stringify({
						operationId,
						outcome: 'rejected',
						error,
					}),
					completedAt: now,
				})
				.where(pending)
				.run();
			return reply(await read());
		};
		const parent = await ownedCar(c, carId);
		if (!parent) return reject('Car not found.');
		if (!canWrite(parent))
			return reject(
				'The Car is archived. Restore it before uploading this photo.',
			);
		const collision = await database
			.select({ id: photo.id })
			.from(photo)
			.where(eq(photo.id, operationId))
			.get();
		if (collision) return reject('Photo capture identity is already in use.');
		const photos = await database
			.select()
			.from(photo)
			.where(eq(photo.carId, carId));
		const objectKey = photoObjectKey(carId, operationId);
		const uploaded = await c.env.PHOTOS.put(objectKey, bytes, {
			onlyIf: { etagDoesNotMatch: '*' },
			httpMetadata: { contentType: parsed.contentType },
			customMetadata: { captureOperationId: operationId, requestHash },
		});
		if (!uploaded) {
			const existing = await c.env.PHOTOS.head(objectKey);
			if (existing?.customMetadata?.requestHash !== requestHash)
				return reject('Photo capture identity is already in use.');
		}
		const record = {
			id: operationId,
			carId,
			objectKey,
			contentType: parsed.contentType,
			fileName: parsed.fileName,
			byteSize: bytes.byteLength,
			sortOrder: photos.length,
			isPrimary: !photos.some((value) => value.isPrimary),
			createdAt: now,
		};
		const witness = and(
			eq(car.id, carId),
			eq(car.ownerId, ownerId),
			eq(car.lastOperationId, operationId),
		);
		const response = {
			operationId,
			outcome: 'applied',
			photo: publicPhoto(record),
		};
		await database.batch([
			database
				.update(car)
				.set({ version: parent.version + 1, lastOperationId: operationId })
				.where(
					and(
						eq(car.id, carId),
						eq(car.ownerId, ownerId),
						eq(car.version, parent.version),
					),
				),
			database.insert(photo).select(
				database
					.select({
						id: sql<string>`${record.id}`.as('id'),
						carId: sql<string>`${carId}`.as('carId'),
						objectKey: sql<string>`${objectKey}`.as('objectKey'),
						contentType: sql<string>`${record.contentType}`.as('contentType'),
						fileName: sql<string>`${record.fileName}`.as('fileName'),
						byteSize: sql<number>`${record.byteSize}`.as('byteSize'),
						sortOrder: sql<number>`${record.sortOrder}`.as('sortOrder'),
						isPrimary: sql<boolean>`${record.isPrimary ? 1 : 0}`.as(
							'isPrimary',
						),
						createdAt: sql<string>`${now}`.as('createdAt'),
					})
					.from(car)
					.where(witness),
			),
			database
				.update(syncOperation)
				.set({
					outcome: 'applied',
					httpStatus: 200,
					responseJson: JSON.stringify(response),
					completedAt: now,
				})
				.where(
					and(
						pending,
						exists(
							database
								.select({ id: photo.id })
								.from(photo)
								.where(and(eq(photo.id, operationId), eq(photo.carId, carId))),
						),
					),
				),
		]);
		return reply(await read());
	});
	routes.get('/photos', async (c) => {
		const rows = await db(c.env)
			.select({ photo })
			.from(photo)
			.innerJoin(car, eq(photo.carId, car.id))
			.where(eq(car.ownerId, c.get('userId')));
		return c.json({ photos: rows.map((row) => publicPhoto(row.photo)) });
	});
	return routes;
};
