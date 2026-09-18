import {
	and,
	eq,
	exists,
	inArray,
	isNull,
	notExists,
	or,
	sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { drivingAnalysis } from '../../schema';
import { cornerClip, cornerClipPublication } from '../clips/clip-schema';
import {
	cornerEvidenceBatch,
	cornerPassEvidence,
} from '../evidence/evidence-schema';
import type { TrackingWorkflowIdentity } from '../tracking/authority-contracts';
import { trackingRun, trackingSegment } from '../tracking/authority-schema';

/** Publish completion in one D1 transaction after every accepted segment is reviewable. */
export const completeDrivingAnalysis = async (
	binding: D1Database,
	identity: TrackingWorkflowIdentity,
	completedAt: string,
): Promise<'completed' | 'not-ready' | 'stale'> => {
	const database = drizzle(binding);
	const runIdentity = and(
		eq(trackingRun.id, identity.runId),
		eq(trackingRun.ownerId, identity.ownerId),
		eq(trackingRun.analysisId, identity.analysisId),
		eq(trackingRun.workflowId, identity.workflowId),
	);
	const analysisIdentity = and(
		eq(drivingAnalysis.id, identity.analysisId),
		eq(drivingAnalysis.ownerId, identity.ownerId),
		eq(drivingAnalysis.workflowId, identity.workflowId),
	);
	const mutableAnalysis = inArray(drivingAnalysis.status, [
		'queued',
		'running',
		'awaiting-reidentification',
	]);
	const missingEvidence = database
		.select({ id: trackingSegment.id })
		.from(trackingSegment)
		.leftJoin(
			cornerEvidenceBatch,
			and(
				eq(cornerEvidenceBatch.artifactId, trackingSegment.acceptedArtifactId),
				eq(cornerEvidenceBatch.segmentId, trackingSegment.id),
				eq(cornerEvidenceBatch.runId, identity.runId),
				eq(cornerEvidenceBatch.ownerId, identity.ownerId),
				eq(cornerEvidenceBatch.analysisId, identity.analysisId),
				eq(cornerEvidenceBatch.workflowId, identity.workflowId),
			),
		)
		.where(
			and(
				eq(trackingSegment.runId, identity.runId),
				or(
					isNull(trackingSegment.acceptedArtifactId),
					isNull(cornerEvidenceBatch.artifactId),
				),
			),
		);
	const missingClips = database
		.select({ id: cornerPassEvidence.batchArtifactId })
		.from(cornerPassEvidence)
		.innerJoin(
			cornerEvidenceBatch,
			and(
				eq(cornerEvidenceBatch.artifactId, cornerPassEvidence.batchArtifactId),
				eq(
					cornerEvidenceBatch.measurementDigest,
					cornerPassEvidence.batchMeasurementDigest,
				),
			),
		)
		.leftJoin(
			cornerClip,
			and(
				eq(cornerClip.batchArtifactId, cornerPassEvidence.batchArtifactId),
				eq(cornerClip.cornerId, cornerPassEvidence.cornerId),
				eq(cornerClip.ordinal, cornerPassEvidence.ordinal),
				eq(cornerClip.runId, identity.runId),
				eq(cornerClip.ownerId, identity.ownerId),
				eq(cornerClip.analysisId, identity.analysisId),
				eq(cornerClip.workflowId, identity.workflowId),
			),
		)
		.leftJoin(
			cornerClipPublication,
			eq(cornerClipPublication.clipId, cornerClip.id),
		)
		.where(
			and(
				eq(cornerEvidenceBatch.runId, identity.runId),
				eq(cornerPassEvidence.eligibility, 'eligible'),
				isNull(cornerClipPublication.clipId),
			),
		);
	const terminalSegment = database
		.select({ id: trackingSegment.id })
		.from(trackingSegment)
		.where(
			and(
				eq(trackingSegment.id, identity.segmentId),
				eq(trackingSegment.runId, identity.runId),
				eq(trackingSegment.outcome, 'completed'),
				sql`${trackingSegment.order} = (SELECT MAX(segment_order) FROM tracking_segment WHERE run_id = ${identity.runId})`,
			),
		);
	const [, published] = await database.batch([
		database
			.update(trackingRun)
			.set({
				status: 'completed',
				version: sql`${trackingRun.version} + 1`,
				completedAt,
			})
			.where(
				and(
					runIdentity,
					eq(trackingRun.status, 'active'),
					exists(
						database
							.select({ id: drivingAnalysis.id })
							.from(drivingAnalysis)
							.where(and(analysisIdentity, mutableAnalysis)),
					),
					exists(terminalSegment),
					notExists(missingEvidence),
					notExists(missingClips),
				),
			),
		database
			.update(drivingAnalysis)
			.set({
				status: 'completed',
				stage: 'finalization',
				progress: 100,
				stateVersion: sql`${drivingAnalysis.stateVersion} + 1`,
				updatedAt: completedAt,
			})
			.where(
				and(
					analysisIdentity,
					mutableAnalysis,
					exists(
						database
							.select({ id: trackingRun.id })
							.from(trackingRun)
							.where(and(runIdentity, eq(trackingRun.status, 'completed'))),
					),
				),
			)
			.returning({ id: drivingAnalysis.id }),
	]);
	if (published.length > 0) return 'completed';
	const current = await database
		.select({
			runStatus: sql<
				(typeof trackingRun.$inferSelect)['status']
			>`${trackingRun.status}`.as('completion_run_status'),
			analysisStatus: sql<
				(typeof drivingAnalysis.$inferSelect)['status']
			>`${drivingAnalysis.status}`.as('completion_analysis_status'),
		})
		.from(trackingRun)
		.innerJoin(
			drivingAnalysis,
			and(eq(drivingAnalysis.id, trackingRun.analysisId), analysisIdentity),
		)
		.where(runIdentity)
		.get();
	if (
		current?.runStatus === 'completed' &&
		current.analysisStatus === 'completed'
	)
		return 'completed';
	return current?.runStatus === 'active' &&
		['queued', 'running', 'awaiting-reidentification'].includes(
			current.analysisStatus,
		)
		? 'not-ready'
		: 'stale';
};
