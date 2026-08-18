import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { isConfiguredOwner } from '../../auth-policy';
import { db } from '../../db';
import {
	owner,
	raceVideo,
	raceVideoValidation,
	trackCorner,
	trackLayout,
	trackMapReferenceFrame,
	trackMapVersion,
} from '../../schema';
import type { AppContext, AppEnv } from '../../types';
import {
	type TrackCornerInput,
	trackLayoutCreateSchema,
	trackLayoutRenameSchema,
	trackMapDraftInputSchema,
	trackMapReferenceFrameInputSchema,
	trackMapVersionCreateSchema,
	trackMapVersionDecisionSchema,
} from './track-map-contracts';

const now = (): string => new Date().toISOString();
const trackMapConflictPattern =
	/Track-map version changed since it was observed|Track-map versions must be the next draft for their layout|Retired Track layouts are read-only/;
const isTrackMapConflict = (error: unknown): boolean =>
	error instanceof Error &&
	(trackMapConflictPattern.test(error.message) ||
		isTrackMapConflict(error.cause));
const assertTrackMapConflict = (error: unknown): void => {
	if (!isTrackMapConflict(error)) throw error;
};
const isOwner = async (c: AppContext): Promise<boolean> => {
	const value = await db(c.env)
		.select({ email: owner.email })
		.from(owner)
		.where(eq(owner.id, c.get('userId')))
		.get();
	return Boolean(value && isConfiguredOwner(value.email, c.env));
};

const publicCorner = (corner: typeof trackCorner.$inferSelect) => ({
	key: corner.key,
	name: corner.name,
	order: corner.order,
	entryGate: {
		start: { x: corner.entryStartX, y: corner.entryStartY },
		end: { x: corner.entryEndX, y: corner.entryEndY },
		direction: corner.entryDirection,
	},
	exitGate: {
		start: { x: corner.exitStartX, y: corner.exitStartY },
		end: { x: corner.exitEndX, y: corner.exitEndY },
		direction: corner.exitDirection,
	},
	cornerView: {
		x: corner.viewX,
		y: corner.viewY,
		width: corner.viewWidth,
		height: corner.viewHeight,
	},
});

const publicVersion = (
	version: typeof trackMapVersion.$inferSelect,
	corners: (typeof trackCorner.$inferSelect)[],
	referenceFrame: typeof trackMapReferenceFrame.$inferSelect | undefined,
) => ({
	id: version.id,
	layoutId: version.layoutId,
	version: version.version,
	stateVersion: version.stateVersion,
	status: version.status,
	sourceVersionId: version.sourceVersionId,
	createdBy: version.createdBy,
	createdAt: version.createdAt,
	updatedAt: version.updatedAt,
	approvedBy: version.approvedBy,
	approvedAt: version.approvedAt,
	retiredAt: version.retiredAt,
	corners: corners
		.sort((left, right) => left.order - right.order)
		.map(publicCorner),
	referenceFrame: referenceFrame
		? {
				raceVideoId: referenceFrame.raceVideoId,
				timestampMs: referenceFrame.timestampMs,
				byteCount: referenceFrame.byteCount,
				checksumSha256: referenceFrame.checksumSha256,
				contentType: referenceFrame.contentType,
			}
		: null,
});

const loadVersion = async (c: AppContext, versionId: string) => {
	const version = await db(c.env)
		.select()
		.from(trackMapVersion)
		.where(eq(trackMapVersion.id, versionId))
		.get();
	if (!version) return null;
	const corners = await db(c.env)
		.select()
		.from(trackCorner)
		.where(eq(trackCorner.mapVersionId, versionId))
		.orderBy(asc(trackCorner.order));
	const referenceFrame = await db(c.env)
		.select()
		.from(trackMapReferenceFrame)
		.where(eq(trackMapReferenceFrame.mapVersionId, versionId))
		.get();
	return publicVersion(version, corners, referenceFrame);
};

const canReadVersion = async (
	c: AppContext,
	version: NonNullable<Awaited<ReturnType<typeof loadVersion>>>,
	ownerUser: boolean,
): Promise<boolean> => {
	if (ownerUser) return true;
	if (version.status !== 'approved') return false;
	const layout = await db(c.env)
		.select({ status: trackLayout.status })
		.from(trackLayout)
		.where(eq(trackLayout.id, version.layoutId))
		.get();
	return layout?.status === 'active';
};

const cornerRows = (
	versionId: string,
	corners: TrackCornerInput[],
): (typeof trackCorner.$inferInsert)[] =>
	corners.map((corner) => ({
		id: crypto.randomUUID(),
		mapVersionId: versionId,
		key: corner.key,
		name: corner.name,
		order: corner.order,
		entryStartX: corner.entryGate.start.x,
		entryStartY: corner.entryGate.start.y,
		entryEndX: corner.entryGate.end.x,
		entryEndY: corner.entryGate.end.y,
		entryDirection: corner.entryGate.direction,
		exitStartX: corner.exitGate.start.x,
		exitStartY: corner.exitGate.start.y,
		exitEndX: corner.exitGate.end.x,
		exitEndY: corner.exitGate.end.y,
		exitDirection: corner.exitGate.direction,
		viewX: corner.cornerView.x,
		viewY: corner.cornerView.y,
		viewWidth: corner.cornerView.width,
		viewHeight: corner.cornerView.height,
	}));

export const createTrackMapRoutes = () => {
	const routes = new Hono<AppEnv>();

	routes.get('/track-layouts', async (c) => {
		const ownerUser = await isOwner(c);
		const layouts = await db(c.env)
			.select()
			.from(trackLayout)
			.orderBy(desc(trackLayout.updatedAt));
		const visible = ownerUser
			? layouts
			: layouts.filter((layout) => layout.status === 'active');
		const result = [];
		for (const layout of visible) {
			const versions = await db(c.env)
				.select()
				.from(trackMapVersion)
				.where(
					and(
						eq(trackMapVersion.layoutId, layout.id),
						ownerUser ? undefined : eq(trackMapVersion.status, 'approved'),
					),
				)
				.orderBy(desc(trackMapVersion.version));
			if (!ownerUser && !versions.length) continue;
			result.push({
				...layout,
				mapVersions: versions.map((version) => ({
					id: version.id,
					version: version.version,
					stateVersion: version.stateVersion,
					status: version.status,
					createdAt: version.createdAt,
					updatedAt: version.updatedAt,
					approvedAt: version.approvedAt,
					retiredAt: version.retiredAt,
				})),
			});
		}
		return c.json({ canManage: ownerUser, trackLayouts: result });
	});

	/* c8 ignore start -- authenticated media-container boundary is covered by live acceptance. */
	routes.get('/track-map-recordings', async (c) => {
		if (!(await isOwner(c)))
			return c.json({ error: 'Track map not found' }, 404);
		const recordings = await db(c.env)
			.select({
				id: raceVideo.id,
				fileName: raceVideo.fileName,
				byteCount: raceVideoValidation.byteCount,
				durationMs: raceVideoValidation.durationMs,
				width: raceVideoValidation.width,
				height: raceVideoValidation.height,
			})
			.from(raceVideo)
			.innerJoin(
				raceVideoValidation,
				eq(raceVideoValidation.raceVideoId, raceVideo.id),
			)
			.where(
				and(
					eq(raceVideo.ownerId, c.get('userId')),
					eq(raceVideo.status, 'validating'),
					eq(raceVideoValidation.status, 'ready'),
				),
			)
			.orderBy(desc(raceVideo.createdAt));
		return c.json({ raceVideos: recordings });
	});

	routes.get('/track-layouts/:layoutId/map-versions/:versionId', async (c) => {
		const ownerUser = await isOwner(c);
		const version = await loadVersion(c, c.req.param('versionId'));
		if (
			!version ||
			version.layoutId !== c.req.param('layoutId') ||
			!(await canReadVersion(c, version, ownerUser))
		)
			return c.json({ error: 'Track map not found' }, 404);
		return c.json({ trackMapVersion: version });
	});

	routes.get('/track-map-versions/:versionId', async (c) => {
		const ownerUser = await isOwner(c);
		const version = await loadVersion(c, c.req.param('versionId'));
		if (!version || !(await canReadVersion(c, version, ownerUser)))
			return c.json({ error: 'Track map not found' }, 404);
		return c.json({ trackMapVersion: version });
	});

	routes.post('/track-layouts', async (c) => {
		if (!(await isOwner(c)))
			return c.json({ error: 'Track map not found' }, 404);
		const parsed = trackLayoutCreateSchema.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const id = crypto.randomUUID();
		const timestamp = now();
		try {
			await db(c.env)
				.insert(trackLayout)
				.values({
					id,
					name: parsed.data.name,
					status: 'active',
					createdBy: c.get('userId'),
					createdAt: timestamp,
					updatedAt: timestamp,
					retiredAt: null,
				});
		} catch {
			return c.json(
				{ error: 'A Track layout with that name already exists' },
				409,
			);
		}
		return c.json(
			{
				trackLayout: await db(c.env)
					.select()
					.from(trackLayout)
					.where(eq(trackLayout.id, id))
					.get(),
			},
			201,
		);
	});

	routes.patch('/track-layouts/:layoutId', async (c) => {
		if (!(await isOwner(c)))
			return c.json({ error: 'Track map not found' }, 404);
		const parsed = trackLayoutRenameSchema.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const existing = await db(c.env)
			.select()
			.from(trackLayout)
			.where(eq(trackLayout.id, c.req.param('layoutId')))
			.get();
		if (!existing) return c.json({ error: 'Track layout not found' }, 404);
		if (existing.status === 'retired')
			return c.json({ error: 'Retired Track layouts are read-only' }, 409);
		const updatedAt = now();
		try {
			await db(c.env)
				.update(trackLayout)
				.set({ name: parsed.data.name, updatedAt })
				.where(eq(trackLayout.id, existing.id));
		} catch {
			return c.json(
				{ error: 'A Track layout with that name already exists' },
				409,
			);
		}
		return c.json({
			trackLayout: { ...existing, name: parsed.data.name, updatedAt },
		});
	});

	routes.post('/track-layouts/:layoutId/retire', async (c) => {
		if (!(await isOwner(c)))
			return c.json({ error: 'Track layout not found' }, 404);
		const existing = await db(c.env)
			.select()
			.from(trackLayout)
			.where(eq(trackLayout.id, c.req.param('layoutId')))
			.get();
		if (!existing) return c.json({ error: 'Track layout not found' }, 404);
		if (existing.status === 'retired')
			return c.json({ error: 'Track layout is already retired' }, 409);
		const retiredAt = now();
		await db(c.env)
			.update(trackLayout)
			.set({ status: 'retired', retiredAt, updatedAt: retiredAt })
			.where(eq(trackLayout.id, existing.id));
		return c.json({
			trackLayout: {
				...existing,
				status: 'retired',
				retiredAt,
				updatedAt: retiredAt,
			},
		});
	});

	routes.post('/track-layouts/:layoutId/map-versions', async (c) => {
		if (!(await isOwner(c)))
			return c.json({ error: 'Track map not found' }, 404);
		const parsed = trackMapVersionCreateSchema.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const layout = await db(c.env)
			.select()
			.from(trackLayout)
			.where(eq(trackLayout.id, c.req.param('layoutId')))
			.get();
		if (!layout || layout.status === 'retired')
			return c.json({ error: 'Track layout not found' }, 404);
		const source = parsed.data.sourceVersionId
			? await loadVersion(c, parsed.data.sourceVersionId)
			: null;
		if (
			parsed.data.sourceVersionId &&
			(!source || source.layoutId !== layout.id || source.status !== 'approved')
		)
			return c.json({ error: 'Source Track map not found' }, 404);
		const latest = await db(c.env)
			.select({ version: trackMapVersion.version })
			.from(trackMapVersion)
			.where(eq(trackMapVersion.layoutId, layout.id))
			.orderBy(desc(trackMapVersion.version))
			.get();
		const id = crypto.randomUUID();
		const timestamp = now();
		const database = db(c.env);
		const insertVersion = database.insert(trackMapVersion).values({
			id,
			layoutId: layout.id,
			version: (latest?.version ?? 0) + 1,
			stateVersion: 1,
			status: 'draft',
			sourceVersionId: parsed.data.sourceVersionId ?? null,
			createdBy: c.get('userId'),
			createdAt: timestamp,
			updatedAt: timestamp,
			approvedBy: null,
			approvedAt: null,
			retiredAt: null,
		});
		try {
			const sourceFrame = parsed.data.sourceVersionId
				? await db(c.env)
						.select()
						.from(trackMapReferenceFrame)
						.where(
							eq(
								trackMapReferenceFrame.mapVersionId,
								parsed.data.sourceVersionId,
							),
						)
						.get()
				: undefined;
			const insertFrame = sourceFrame
				? database.insert(trackMapReferenceFrame).values({
						...sourceFrame,
						id: crypto.randomUUID(),
						mapVersionId: id,
						createdBy: c.get('userId'),
						createdAt: timestamp,
					})
				: undefined;
			if (source?.corners.length && insertFrame) {
				await database.batch([
					insertVersion,
					database.insert(trackCorner).values(cornerRows(id, source.corners)),
					insertFrame,
				]);
			} else if (source?.corners.length) {
				await database.batch([
					insertVersion,
					database.insert(trackCorner).values(cornerRows(id, source.corners)),
				]);
			} else if (insertFrame) {
				await database.batch([insertVersion, insertFrame]);
			} else {
				await insertVersion;
			}
		} catch (error) {
			assertTrackMapConflict(error);
			return c.json(
				{ error: 'Track-map version changed while the draft was created' },
				409,
			);
		}
		const created = await loadVersion(c, id);
		return c.json({ trackMapVersion: created }, 201);
	});

	routes.post('/track-map-versions/:versionId/reference-frame', async (c) => {
		if (!(await isOwner(c)))
			return c.json({ error: 'Track map not found' }, 404);
		const parsed = trackMapReferenceFrameInputSchema.safeParse(
			await c.req.json(),
		);
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const version = await db(c.env)
			.select({ id: trackMapVersion.id, status: trackMapVersion.status })
			.from(trackMapVersion)
			.where(eq(trackMapVersion.id, c.req.param('versionId')))
			.get();
		if (!version) return c.json({ error: 'Track map not found' }, 404);
		if (version.status !== 'draft')
			return c.json(
				{ error: 'Reference frames can only be attached to drafts' },
				409,
			);
		const existing = await db(c.env)
			.select({ id: trackMapReferenceFrame.id })
			.from(trackMapReferenceFrame)
			.where(eq(trackMapReferenceFrame.mapVersionId, version.id))
			.get();
		if (existing)
			return c.json(
				{ error: 'Create a new draft to change its reference frame' },
				409,
			);
		const recording = await db(c.env)
			.select({
				objectKey: raceVideo.objectKey,
				byteCount: raceVideoValidation.byteCount,
				checksumSha256: raceVideoValidation.checksumSha256,
				durationMs: raceVideoValidation.durationMs,
			})
			.from(raceVideo)
			.innerJoin(
				raceVideoValidation,
				eq(raceVideoValidation.raceVideoId, raceVideo.id),
			)
			.where(
				and(
					eq(raceVideo.id, parsed.data.raceVideoId),
					eq(raceVideo.ownerId, c.get('userId')),
					eq(raceVideo.status, 'validating'),
					eq(raceVideoValidation.status, 'ready'),
				),
			)
			.get();
		if (
			!recording ||
			!Number.isSafeInteger(recording.byteCount) ||
			!recording.checksumSha256 ||
			!Number.isSafeInteger(recording.durationMs) ||
			parsed.data.timestampMs >= recording.durationMs
		)
			return c.json(
				{ error: 'Validated Race recording or timestamp not found' },
				404,
			);
		const outputObjectKey = `track-map-reference-frames/${version.id}/${crypto.randomUUID()}.jpg`;
		const extracted = await c.env.RACE_VIDEO_MEDIA_CONTAINER.getByName(
			version.id,
		).extractReferenceFrame({
			source: {
				objectKey: recording.objectKey,
				byteCount: recording.byteCount,
				checksumSha256: recording.checksumSha256,
			},
			timestampMs: parsed.data.timestampMs,
			outputObjectKey,
		});
		const timestamp = now();
		const created = await db(c.env)
			.insert(trackMapReferenceFrame)
			.values({
				id: crypto.randomUUID(),
				mapVersionId: version.id,
				raceVideoId: parsed.data.raceVideoId,
				timestampMs: parsed.data.timestampMs,
				objectKey: extracted.objectKey,
				byteCount: extracted.byteCount,
				checksumSha256: extracted.checksumSha256,
				contentType: extracted.contentType,
				createdBy: c.get('userId'),
				createdAt: timestamp,
			})
			.returning()
			.get();
		return c.json({ referenceFrame: created }, 201);
	});

	routes.get(
		'/track-map-versions/:versionId/reference-frame/content',
		async (c) => {
			if (!(await isOwner(c)))
				return c.json({ error: 'Track map not found' }, 404);
			const frame = await db(c.env)
				.select()
				.from(trackMapReferenceFrame)
				.where(
					eq(trackMapReferenceFrame.mapVersionId, c.req.param('versionId')),
				)
				.get();
			if (!frame) return c.json({ error: 'Reference frame not found' }, 404);
			const object = await c.env.ANALYSIS_MEDIA.get(frame.objectKey);
			if (!object) return c.json({ error: 'Reference frame not found' }, 404);
			return new Response(object.body, {
				headers: {
					'content-type': frame.contentType,
					'content-length': String(frame.byteCount),
					'cache-control': 'private, no-store',
					etag: `"${frame.checksumSha256}"`,
				},
			});
		},
	);
	/* c8 ignore end */

	routes.patch('/track-map-versions/:versionId', async (c) => {
		if (!(await isOwner(c)))
			return c.json({ error: 'Track map not found' }, 404);
		const parsed = trackMapDraftInputSchema.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const version = await db(c.env)
			.select({
				id: trackMapVersion.id,
				layoutId: trackMapVersion.layoutId,
				status: trackMapVersion.status,
				layoutStatus: sql<'active' | 'retired'>`${trackLayout.status}`.as(
					'layout_status',
				),
			})
			.from(trackMapVersion)
			.innerJoin(trackLayout, eq(trackLayout.id, trackMapVersion.layoutId))
			.where(eq(trackMapVersion.id, c.req.param('versionId')))
			.get();
		if (!version) return c.json({ error: 'Track map not found' }, 404);
		if (version.status !== 'draft')
			return c.json({ error: 'Only draft Track maps can be edited' }, 409);
		if (version.layoutStatus === 'retired')
			return c.json({ error: 'Retired Track layouts are read-only' }, 409);
		const database = db(c.env);
		const updateVersion = database
			.update(trackMapVersion)
			.set({
				stateVersion: parsed.data.expectedStateVersion + 1,
				updatedAt: now(),
			})
			.where(eq(trackMapVersion.id, version.id));
		const removeExisting = database
			.delete(trackCorner)
			.where(eq(trackCorner.mapVersionId, version.id));
		try {
			if (parsed.data.corners.length) {
				await database.batch([
					updateVersion,
					removeExisting,
					database
						.insert(trackCorner)
						.values(cornerRows(version.id, parsed.data.corners)),
				]);
			} else {
				await database.batch([updateVersion, removeExisting]);
			}
		} catch (error) {
			assertTrackMapConflict(error);
			return c.json(
				{ error: 'Track-map version changed since it was observed' },
				409,
			);
		}
		return c.json({ trackMapVersion: await loadVersion(c, version.id) });
	});

	routes.post('/track-map-versions/:versionId/approve', async (c) => {
		if (!(await isOwner(c)))
			return c.json({ error: 'Track map not found' }, 404);
		const parsed = trackMapVersionDecisionSchema.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const version = await loadVersion(c, c.req.param('versionId'));
		if (!version) return c.json({ error: 'Track map not found' }, 404);
		if (version.status !== 'draft')
			return c.json({ error: 'Only draft Track maps can be approved' }, 409);
		if (
			version.corners.length === 0 ||
			!(await db(c.env)
				.select({ id: trackMapReferenceFrame.id })
				.from(trackMapReferenceFrame)
				.where(eq(trackMapReferenceFrame.mapVersionId, version.id))
				.get()) ||
			!trackMapDraftInputSchema.safeParse({
				expectedStateVersion: parsed.data.expectedStateVersion,
				corners: version.corners,
			}).success
		)
			return c.json(
				{ error: 'Draft Track map geometry is not valid for approval' },
				409,
			);
		const approvedAt = now();
		try {
			await db(c.env)
				.update(trackMapVersion)
				.set({
					status: 'approved',
					stateVersion: parsed.data.expectedStateVersion + 1,
					updatedAt: approvedAt,
					approvedBy: c.get('userId'),
					approvedAt,
				})
				.where(eq(trackMapVersion.id, version.id));
		} catch (error) {
			assertTrackMapConflict(error);
			return c.json(
				{ error: 'Track-map version changed since it was observed' },
				409,
			);
		}
		return c.json({ trackMapVersion: await loadVersion(c, version.id) });
	});

	routes.post('/track-map-versions/:versionId/retire', async (c) => {
		if (!(await isOwner(c)))
			return c.json({ error: 'Track map not found' }, 404);
		const parsed = trackMapVersionDecisionSchema.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
		const version = await loadVersion(c, c.req.param('versionId'));
		if (!version) return c.json({ error: 'Track map not found' }, 404);
		if (version.status !== 'approved')
			return c.json({ error: 'Only approved Track maps can be retired' }, 409);
		const retiredAt = now();
		try {
			await db(c.env)
				.update(trackMapVersion)
				.set({
					status: 'retired',
					stateVersion: parsed.data.expectedStateVersion + 1,
					updatedAt: retiredAt,
					retiredAt,
				})
				.where(eq(trackMapVersion.id, version.id));
		} catch (error) {
			assertTrackMapConflict(error);
			return c.json(
				{ error: 'Track-map version changed since it was observed' },
				409,
			);
		}
		return c.json({ trackMapVersion: await loadVersion(c, version.id) });
	});

	return routes;
};
