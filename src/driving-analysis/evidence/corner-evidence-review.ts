import { and, asc, eq, getTableColumns, notInArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { drivingAnalysis, trackCorner } from '../../schema';
import {
	preparedTrackingMedia,
	trackingRun,
	trackingSegment,
} from '../tracking/authority-schema';
import { preparedMediaArtifactSchema } from '../tracking/contracts';
import { type CornerPassEvidence, rankCornerPasses } from './corner-evidence';
import { cornerEvidenceBatch, cornerPassEvidence } from './evidence-schema';

export type ReviewedCornerPass = CornerPassEvidence &
	Readonly<{
		provenance: Readonly<{
			segmentId: string;
			segmentSequence: number;
			profileDigest: string;
			observationChecksum: string;
			manifestChecksum: string;
			measurementVersion: string;
			measurementDigest: string;
		}>;
	}>;

export type CornerReview = Readonly<{
	analysisId: string;
	carId: string;
	driveSessionId: string;
	stateVersion: number;
	status: string;
	runId: string | null;
	trackMapVersionId: string;
	tieToleranceMs: number | null;
	corners: readonly Readonly<{
		id: string;
		name: string;
		order: number;
		passes: readonly ReviewedCornerPass[];
	}>[];
}>;

/** A single D1 snapshot joins only accepted evidence from the current run. */
export class CornerEvidenceReview {
	private readonly database;
	constructor(binding: D1Database) {
		this.database = drizzle(binding);
	}

	async get(ownerId: string, analysisId: string): Promise<CornerReview | null> {
		const rows = await this.database
			.select({
				analysis: {
					analysisId: sql<string>`${drivingAnalysis.id}`.as(
						'review_analysis_id',
					),
					carId: drivingAnalysis.carId,
					driveSessionId: drivingAnalysis.driveSessionId,
					stateVersion: drivingAnalysis.stateVersion,
					status: drivingAnalysis.status,
					trackMapVersionId: drivingAnalysis.approvedTrackMapVersionId,
				},
				run: { id: sql<string>`${trackingRun.id}`.as('review_run_id') },
				prepared: { descriptor: preparedTrackingMedia.descriptorJson },
				corner: {
					id: trackCorner.id,
					name: trackCorner.name,
					order: sql<number>`${trackCorner.order}`.as('review_corner_order'),
				},
				provenance: {
					segmentId: cornerEvidenceBatch.segmentId,
					profileDigest: cornerEvidenceBatch.profileDigest,
					observationChecksum: cornerEvidenceBatch.observationChecksumSha256,
					manifestChecksum: cornerEvidenceBatch.manifestChecksumSha256,
					measurementVersion: cornerEvidenceBatch.measurementVersion,
					measurementDigest: cornerEvidenceBatch.measurementDigest,
				},
				segment: { sequence: trackingSegment.order },
				pass: getTableColumns(cornerPassEvidence),
			})
			.from(drivingAnalysis)
			.leftJoin(
				trackingRun,
				and(
					eq(trackingRun.analysisId, drivingAnalysis.id),
					eq(trackingRun.ownerId, drivingAnalysis.ownerId),
					eq(trackingRun.workflowId, drivingAnalysis.workflowId),
				),
			)
			.leftJoin(
				preparedTrackingMedia,
				eq(preparedTrackingMedia.runId, trackingRun.id),
			)
			.innerJoin(
				trackCorner,
				eq(trackCorner.mapVersionId, drivingAnalysis.approvedTrackMapVersionId),
			)
			.leftJoin(trackingSegment, eq(trackingSegment.runId, trackingRun.id))
			.leftJoin(
				cornerEvidenceBatch,
				and(
					eq(
						cornerEvidenceBatch.artifactId,
						trackingSegment.acceptedArtifactId,
					),
					eq(cornerEvidenceBatch.segmentId, trackingSegment.id),
					eq(cornerEvidenceBatch.runId, trackingRun.id),
					eq(cornerEvidenceBatch.ownerId, drivingAnalysis.ownerId),
				),
			)
			.leftJoin(
				cornerPassEvidence,
				and(
					eq(
						cornerPassEvidence.batchArtifactId,
						cornerEvidenceBatch.artifactId,
					),
					eq(
						cornerPassEvidence.batchMeasurementDigest,
						cornerEvidenceBatch.measurementDigest,
					),
					eq(cornerPassEvidence.cornerId, trackCorner.id),
				),
			)
			.where(
				and(
					eq(drivingAnalysis.id, analysisId),
					eq(drivingAnalysis.ownerId, ownerId),
					notInArray(drivingAnalysis.status, ['deleting', 'deleted']),
				),
			)
			.orderBy(
				asc(trackCorner.order),
				asc(trackingSegment.order),
				asc(cornerPassEvidence.ordinal),
			);
		const first = rows[0];
		if (!first) return null;
		const prepared =
			first.prepared &&
			preparedMediaArtifactSchema.parse(JSON.parse(first.prepared.descriptor));
		const tieToleranceMs = prepared
			? (1000 * prepared.averageFrameRate.denominator) /
				prepared.averageFrameRate.numerator
			: null;
		const corners = new Map<
			string,
			{ id: string; name: string; order: number; passes: ReviewedCornerPass[] }
		>();
		for (const row of rows) {
			let corner = corners.get(row.corner.id);
			if (!corner) {
				corner = { ...row.corner, passes: [] };
				corners.set(corner.id, corner);
			}
			const pass = row.pass;
			if (!pass || !row.provenance || !row.segment) continue;
			corner.passes.push({
				cornerId: pass.cornerId,
				cornerKey: pass.cornerKey,
				cornerOrder: pass.cornerOrder,
				ordinal: pass.ordinal,
				entry: crossing(
					pass.entryTimestampMs,
					pass.entryBeforeFrameIndex,
					pass.entryAfterFrameIndex,
				),
				exit: crossing(
					pass.exitTimestampMs,
					pass.exitBeforeFrameIndex,
					pass.exitAfterFrameIndex,
				),
				durationMs: pass.durationMs,
				eligibility: pass.eligibility,
				exclusionReason: pass.exclusionReason,
				rank: pass.rank,
				tieGroup: pass.tieGroup,
				best: pass.best,
				provenance: {
					...row.provenance,
					segmentSequence: row.segment.sequence,
				},
			});
		}
		return {
			...first.analysis,
			runId: first.run?.id ?? null,
			tieToleranceMs,
			corners: [...corners.values()].map((corner) => ({
				...corner,
				passes: rankCornerPasses(corner.passes, tieToleranceMs ?? 0),
			})),
		};
	}
}

const crossing = (
	timestampMs: number | null,
	beforeFrameIndex: number | null,
	afterFrameIndex: number | null,
) =>
	timestampMs === null || beforeFrameIndex === null || afterFrameIndex === null
		? null
		: { timestampMs, beforeFrameIndex, afterFrameIndex };
