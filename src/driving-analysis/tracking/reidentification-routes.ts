import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db';
import { drivingAnalysis } from '../../schema';
import type { AppEnv } from '../../types';
import { trackingRun, trackingSegment } from './authority-schema';
import { sha256Schema, subjectSeedSchema, uuidV4Schema } from './contracts';
import { R2TrackingArtifactStore } from './r2-tracking-artifact-store';
import {
	TrackingAuthority,
	TrackingAuthorityError,
} from './tracking-authority';

const correctionSchema = z.strictObject({
	runId: uuidV4Schema,
	segmentId: uuidV4Schema,
	correctionId: uuidV4Schema,
	acceptedDigest: sha256Schema,
	subjectSeed: subjectSeedSchema,
});

const currentRun = async (
	binding: D1Database,
	ownerId: string,
	analysisId: string,
) => {
	const run = await db({ DB: binding })
		.select({
			runId: trackingRun.id,
			workflowId: trackingRun.workflowId,
		})
		.from(trackingRun)
		.innerJoin(
			drivingAnalysis,
			and(
				eq(drivingAnalysis.id, trackingRun.analysisId),
				eq(drivingAnalysis.workflowId, trackingRun.workflowId),
				eq(drivingAnalysis.ownerId, trackingRun.ownerId),
			),
		)
		.where(
			and(
				eq(trackingRun.ownerId, ownerId),
				eq(trackingRun.analysisId, analysisId),
				eq(trackingRun.status, 'active'),
			),
		)
		.get();
	if (!run)
		throw new TrackingAuthorityError(
			'NOT_FOUND',
			'Current tracking run not found',
		);
	return { ...run, ownerId, analysisId };
};

export const createReidentificationRoutes = () => {
	const routes = new Hono<AppEnv>();
	routes.onError((error, c) => {
		if (error instanceof TrackingAuthorityError)
			return c.json(
				{ error: error.message },
				error.code === 'NOT_FOUND' ? 404 : 409,
			);
		throw error;
	});
	routes.get('/driving-analyses/:analysisId/reidentification', async (c) => {
		const identity = await currentRun(
			c.env.DB,
			c.get('userId'),
			c.req.param('analysisId'),
		);
		const provenance = await new TrackingAuthority(c.env.DB).publicProvenance(
			identity.ownerId,
			identity.analysisId,
			identity.runId,
		);
		let segment = provenance.segments.at(-1);
		let pendingCorrection:
			| { correctionId: string; subjectSeed: z.infer<typeof subjectSeedSchema> }
			| undefined;
		if (segment && segment.outcome === null) {
			const pending = await db(c.env)
				.select({
					correctionId: trackingSegment.id,
					predecessor: trackingSegment.seedSourceId,
					seedJson: trackingSegment.seedJson,
				})
				.from(trackingSegment)
				.where(
					and(
						eq(trackingSegment.id, segment.segmentId),
						eq(trackingSegment.runId, identity.runId),
						eq(trackingSegment.seedKind, 'reidentification'),
					),
				)
				.get();
			if (pending) {
				segment = provenance.segments.find(
					(value) => value.segmentId === pending.predecessor,
				);
				pendingCorrection = {
					correctionId: pending.correctionId,
					subjectSeed: subjectSeedSchema.parse(JSON.parse(pending.seedJson)),
				};
			}
		}
		const gap = segment?.gap;
		const context =
			gap && segment.artifact
				? {
						runId: identity.runId,
						segmentId: segment.segmentId,
						acceptedDigest: segment.artifact.digest,
						gap: segment.gap,
						frames: (
							await new TrackingAuthority(c.env.DB).reidentificationFrames(
								{ ...identity, segmentId: segment.segmentId },
								new R2TrackingArtifactStore(c.env.ANALYSIS_MEDIA),
							)
						).filter((frame) => frame.timestampMs > gap.startTimestampMs),
						...(pendingCorrection ? { pendingCorrection } : {}),
					}
				: null;
		return c.json({ context });
	});
	routes.post('/driving-analyses/:analysisId/reidentification', async (c) => {
		const parsed = correctionSchema.safeParse(
			await c.req.json().catch(() => undefined),
		);
		if (!parsed.success)
			return c.json(
				{ error: 'Provide a valid later Subject frame and normalized box.' },
				400,
			);
		const command = parsed.data;
		const identity = await currentRun(
			c.env.DB,
			c.get('userId'),
			c.req.param('analysisId'),
		);
		if (identity.runId !== command.runId)
			return c.json({ error: 'The tracking run has changed.' }, 409);
		const next = await new TrackingAuthority(c.env.DB).reidentify(
			{ ...identity, segmentId: command.segmentId },
			command.correctionId,
			command.acceptedDigest,
			command.subjectSeed,
			new R2TrackingArtifactStore(c.env.ANALYSIS_MEDIA),
		);
		try {
			const workflow = await c.env.DRIVING_ANALYSIS_WORKFLOW.get(
				identity.workflowId,
			);
			await workflow.sendEvent({
				type: 'tracking-reidentified',
				payload: { correctionId: command.correctionId },
			});
		} catch {
			return c.json(
				{
					error:
						'The correction is saved. Retry the same correction to resume tracking.',
				},
				503,
			);
		}
		return c.json(
			{
				correctionId: command.correctionId,
				runId: next.runId,
				segmentId: next.segmentId,
			},
			202,
		);
	});
	return routes;
};
