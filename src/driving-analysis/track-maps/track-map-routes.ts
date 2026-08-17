import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { isConfiguredOwner } from '../../auth-policy';
import { db } from '../../db';
import { owner, trackCorner, trackLayout, trackMapVersion } from '../../schema';
import type { AppContext, AppEnv } from '../../types';
import {
	type TrackCornerInput,
	trackLayoutCreateSchema,
	trackLayoutRenameSchema,
	trackMapDraftInputSchema,
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
	return publicVersion(version, corners);
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
			if (source?.corners.length) {
				await database.batch([
					insertVersion,
					database.insert(trackCorner).values(cornerRows(id, source.corners)),
				]);
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
