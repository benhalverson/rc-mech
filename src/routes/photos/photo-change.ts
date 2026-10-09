import { and, eq, exists, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { applyPhotoChange, photoBaseMatches } from '../../../shared/photo-sync';
import { db } from '../../db';
import { photoChangeInput } from '../../photo-sync-contract';
import { car, photo, syncOperation } from '../../schema';
import type { AppEnv } from '../../types';
import { ownedCar } from '../cars/car-records';
import { publicPhoto } from './photo-records';

/**
 * Applies queued gallery edits against exact saved photo revisions/membership.
 * Replacement bytes use a new immutable key; metadata and receipt commit before
 * old-object cleanup. Receipt replay resumes cleanup safely, while revision and
 * pending-receipt witnesses fence remote edits and concurrent duplicate requests.
 */
export const createPhotoChangeRoutes = () => {
	const routes = new Hono<AppEnv>();
	routes.onError(
		() =>
			new Response(
				JSON.stringify({
					error:
						'Photo changes remain on this device. Synchronization will retry.',
				}),
				{ status: 503, headers: { 'content-type': 'application/json' } },
			),
	);
	routes.put('/cars/:carId/photos/operations/:operationId', async (c) => {
		const id = z.uuid().safeParse(c.req.param('operationId'));
		if (!id.success)
			return c.json({ error: 'Invalid photo operation identity.' }, 400);
		let body: Record<string, string | File>;
		let input: unknown;
		try {
			body = await c.req.parseBody();
			input = JSON.parse(String(body.command));
		} catch {
			return c.json({ error: 'Invalid photo change.' }, 422);
		}
		const parsed = photoChangeInput.safeParse(input);
		if (!parsed.success || parsed.data.carId !== c.req.param('carId'))
			return c.json({ error: 'Invalid photo change.' }, 422);
		const change = {
			...parsed.data,
			photoId: parsed.data.photoId ?? null,
			replacement: parsed.data.replacement ?? null,
		};
		const operationId = id.data;
		const replacement = change.replacement;
		const file = body.file;
		if (
			replacement
				? !(file instanceof File) ||
					file.name !== replacement.fileName ||
					file.type !== replacement.contentType ||
					file.size !== replacement.byteSize
				: file !== undefined
		)
			return c.json(
				{ error: 'Photo replacement bytes do not match the change.' },
				422,
			);
		const bytes = file instanceof File ? await file.arrayBuffer() : null;
		const digest = async (value: ArrayBuffer | Uint8Array) =>
			[...new Uint8Array(await crypto.subtle.digest('SHA-256', value))]
				.map((byte) => byte.toString(16).padStart(2, '0'))
				.join('');
		const requestHash = await digest(
			new TextEncoder().encode(
				JSON.stringify({ change, digest: bytes ? await digest(bytes) : null }),
			),
		);
		const database = db(c.env);
		const ownerId = c.get('userId');
		const now = new Date().toISOString();
		const identity = and(
			eq(syncOperation.ownerId, ownerId),
			eq(syncOperation.operationId, operationId),
		);
		const pending = and(
			identity,
			eq(syncOperation.requestHash, requestHash),
			eq(syncOperation.outcome, 'pending'),
		);
		const read = () =>
			database.select().from(syncOperation).where(identity).get();
		const reply = async (
			receipt: typeof syncOperation.$inferSelect | undefined,
		): Promise<Response> => {
			if (
				!receipt ||
				receipt.outcome === 'pending' ||
				receipt.httpStatus === null ||
				receipt.responseJson === null
			)
				throw new Error('Photo receipt is pending.');
			const stored = JSON.parse(receipt.responseJson) as {
				response: unknown;
				cleanup: string[];
			};
			// Cleanup is part of acknowledgement and is safe to repeat after a lost response.
			for (const key of stored.cleanup) await c.env.PHOTOS.delete(key);
			return new Response(JSON.stringify(stored.response), {
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
				kind: 'photo.change',
				entityType: 'photo',
				entityId: change.carId,
				requestHash,
				outcome: 'pending',
				createdAt: now,
			})
			.onConflictDoNothing()
			.returning()
			.get();
		const receipt = claimed ?? (await read());
		if (!receipt) throw new Error('Photo change is being synchronized.');
		if (receipt.requestHash !== requestHash)
			return c.json(
				{
					error:
						'Photo operation identity was already used for different content.',
				},
				409,
			);
		if (receipt.outcome !== 'pending') return reply(receipt);
		const complete = async (
			outcome: 'rejected' | 'conflict',
			message: string,
			remote?: ReturnType<typeof publicPhoto>[],
			cleanup: string[] = [],
		) => {
			const response = {
				operationId,
				outcome,
				error: { code: 'PHOTO_CHANGE_REJECTED', message },
				...(remote ? { remote } : {}),
			};
			await database
				.update(syncOperation)
				.set({
					outcome,
					httpStatus: 409,
					responseJson: JSON.stringify({ response, cleanup }),
					completedAt: now,
				})
				.where(pending)
				.run();
			return reply(await read());
		};
		const pendingKey = `cars/${change.carId}/photo-changes/${operationId}`;
		const cleanupPendingReplacement = async () => {
			const object = await c.env.PHOTOS.head(pendingKey);
			return object?.customMetadata?.requestHash === requestHash
				? [pendingKey]
				: [];
		};
		const parent = await ownedCar(c, change.carId);
		if (!parent || parent.archivedAt !== null)
			return complete(
				'rejected',
				'An active Car is required to change these photos.',
				undefined,
				await cleanupPendingReplacement(),
			);
		const photos = await database
			.select()
			.from(photo)
			.where(eq(photo.carId, change.carId));
		if (!photoBaseMatches(change, photos))
			return complete(
				'conflict',
				'The saved gallery changed. Review both versions before retrying.',
				photos.map(publicPhoto),
				await cleanupPendingReplacement(),
			);
		const existing = photos.find((value) => value.id === change.photoId);
		const objectKey = `cars/${change.carId}/photo-changes/${operationId}`;
		if (bytes && replacement) {
			const uploaded = await c.env.PHOTOS.put(objectKey, bytes, {
				onlyIf: { etagDoesNotMatch: '*' },
				httpMetadata: { contentType: replacement.contentType },
				customMetadata: { requestHash },
			});
			if (
				!uploaded &&
				(await c.env.PHOTOS.head(objectKey))?.customMetadata?.requestHash !==
					requestHash
			)
				return complete(
					'rejected',
					'The replacement identity is already in use.',
				);
		}
		const next = applyPhotoChange(photos, change).map((value) =>
			value.id === change.photoId && replacement
				? { ...value, objectKey }
				: value,
		);
		const unchanged = and(
			sql`(select count(*) from photo where car_id = ${change.carId}) = ${photos.length}`,
			sql`not exists (select 1 from photo p where p.car_id = ${change.carId} and not exists (select 1 from json_each(${JSON.stringify(photos.map((value) => ({ id: value.id, revision: value.revision })))}) expected where json_extract(expected.value, '$.id') = p.id and json_extract(expected.value, '$.revision') = p.revision))`,
		);
		const receiptPending = exists(
			database
				.select({ id: syncOperation.operationId })
				.from(syncOperation)
				.where(pending),
		);
		const witness = and(
			receiptPending,
			exists(
				database
					.select({ id: car.id })
					.from(car)
					.where(
						and(
							eq(car.id, change.carId),
							eq(car.ownerId, ownerId),
							eq(car.version, parent.version + 1),
							eq(car.lastOperationId, operationId),
							isNull(car.archivedAt),
						),
					),
			),
		);
		const cleanup =
			existing && (change.action === 'replace' || change.action === 'delete')
				? [existing.objectKey]
				: [];
		const response = {
			operationId,
			outcome: 'applied',
			photos: next.map(publicPhoto),
		};
		const mutations = next
			.filter(
				(value) =>
					value.revision !==
					photos.find((old) => old.id === value.id)?.revision,
			)
			.map((value) =>
				database
					.update(photo)
					.set(value)
					.where(
						and(eq(photo.id, value.id), eq(photo.carId, change.carId), witness),
					),
			);
		const batch = await database.batch([
			database
				.update(car)
				.set({ version: parent.version + 1, lastOperationId: operationId })
				.where(
					and(
						eq(car.id, change.carId),
						eq(car.ownerId, ownerId),
						eq(car.version, parent.version),
						isNull(car.archivedAt),
						receiptPending,
						unchanged,
					),
				),
			...mutations,
			...(change.action === 'delete' && existing
				? [
						database
							.delete(photo)
							.where(
								and(
									eq(photo.id, existing.id),
									eq(photo.carId, change.carId),
									witness,
								),
							),
					]
				: []),
			database
				.update(syncOperation)
				.set({
					outcome: 'applied',
					httpStatus: 200,
					responseJson: JSON.stringify({ response, cleanup }),
					completedAt: now,
				})
				.where(and(pending, witness)),
		]);
		if (batch[0].meta.changes === 0) {
			// A concurrent owner operation may have won. Preserve the pending identity;
			// retry rechecks the gallery before making any mutation.
			throw new Error('The Car changed during synchronization.');
		}
		return reply(await read());
	});
	return routes;
};
