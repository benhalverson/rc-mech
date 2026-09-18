import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { drivingAnalysis, trackCorner } from '../../schema';
import type { AcceptedCornerEvidenceIdentity } from '../evidence/accepted-corner-evidence';
import {
	cornerEvidenceBatch,
	cornerPassEvidence,
} from '../evidence/evidence-schema';
import {
	trackingRun,
	trackingRunInput,
	trackingSegment,
} from '../tracking/authority-schema';
import { cornerClip, cornerClipPublication } from './clip-schema';
import {
	type ClipArtifact,
	type ClipSpecification,
	clipSpecificationSchema,
} from './corner-clip-contracts';

export class ClipAuthorityError extends Error {
	constructor(
		readonly code: 'STALE_AUTHORITY' | 'NOT_FOUND' | 'NOT_READY' | 'DELETED',
	) {
		super(code);
	}
}

export type PlannedClip = typeof cornerClip.$inferSelect;
export class CornerClipAuthority {
	private readonly database;
	constructor(binding: D1Database) {
		this.database = drizzle(binding);
	}

	async inputs(identity: AcceptedCornerEvidenceIdentity) {
		return this.database
			.select({
				pass: cornerPassEvidence,
				corner: trackCorner,
				batch: cornerEvidenceBatch,
				source: trackingRunInput,
			})
			.from(cornerEvidenceBatch)
			.innerJoin(
				cornerPassEvidence,
				eq(cornerPassEvidence.batchArtifactId, cornerEvidenceBatch.artifactId),
			)
			.innerJoin(trackCorner, eq(trackCorner.id, cornerPassEvidence.cornerId))
			.innerJoin(
				trackingRunInput,
				eq(trackingRunInput.runId, cornerEvidenceBatch.runId),
			)
			.innerJoin(trackingRun, eq(trackingRun.id, cornerEvidenceBatch.runId))
			.innerJoin(
				trackingSegment,
				and(
					eq(trackingSegment.id, cornerEvidenceBatch.segmentId),
					eq(
						trackingSegment.acceptedArtifactId,
						cornerEvidenceBatch.artifactId,
					),
				),
			)
			.innerJoin(
				drivingAnalysis,
				and(
					eq(drivingAnalysis.id, cornerEvidenceBatch.analysisId),
					eq(drivingAnalysis.workflowId, trackingRun.workflowId),
				),
			)
			.where(
				and(
					eq(cornerEvidenceBatch.ownerId, identity.ownerId),
					eq(cornerEvidenceBatch.analysisId, identity.analysisId),
					eq(cornerEvidenceBatch.runId, identity.runId),
					eq(cornerEvidenceBatch.workflowId, identity.workflowId),
					eq(cornerEvidenceBatch.segmentId, identity.segmentId),
					eq(cornerPassEvidence.eligibility, 'eligible'),
					inArray(drivingAnalysis.status, [
						'running',
						'awaiting-reidentification',
					]),
					inArray(trackingRun.status, ['active', 'completed']),
					eq(
						trackCorner.mapVersionId,
						cornerEvidenceBatch.approvedTrackMapVersionId,
					),
				),
			);
	}

	async plan(
		identity: AcceptedCornerEvidenceIdentity,
		pass: { batchArtifactId: string; cornerId: string; ordinal: number },
		specification: ClipSpecification,
		inputDigest: string,
		source: { objectKey: string; byteCount: number },
	): Promise<PlannedClip> {
		await this.database
			.insert(cornerClip)
			.values({
				id: crypto.randomUUID(),
				inputDigest,
				...identity,
				batchArtifactId: pass.batchArtifactId,
				cornerId: pass.cornerId,
				ordinal: pass.ordinal,
				specificationJson: JSON.stringify(
					clipSpecificationSchema.parse(specification),
				),
				sourceObjectKey: source.objectKey,
				sourceByteCount: source.byteCount,
				createdAt: new Date().toISOString(),
			})
			.onConflictDoNothing();
		const existing = await this.database
			.select()
			.from(cornerClip)
			.where(eq(cornerClip.inputDigest, inputDigest))
			.get();
		if (
			!existing ||
			existing.runId !== identity.runId ||
			existing.batchArtifactId !== pass.batchArtifactId ||
			existing.specificationJson !== JSON.stringify(specification)
		)
			throw new ClipAuthorityError('STALE_AUTHORITY');
		return existing;
	}

	async publication(clipId: string) {
		return this.database
			.select()
			.from(cornerClipPublication)
			.where(eq(cornerClipPublication.clipId, clipId))
			.get();
	}

	async publish(
		clip: PlannedClip,
		artifact: ClipArtifact,
		objectKey: string,
	): Promise<void> {
		const specification = clipSpecificationSchema.parse(
			JSON.parse(clip.specificationJson),
		);
		if (
			artifact.renderId !== clip.id ||
			artifact.caseId !== clip.runId ||
			artifact.sourceChecksumSha256 !== specification.sourceChecksumSha256
		)
			throw new ClipAuthorityError('STALE_AUTHORITY');
		await this.database
			.insert(cornerClipPublication)
			.select(
				this.database
					.select({
						clipId: cornerClip.id,
						objectKey: sql<string>`${objectKey}`,
						checksum: sql<string>`${artifact.checksumSha256}`,
						byteCount: sql<number>`${artifact.byteCount}`,
						renderInputDigest: sql<string>`${artifact.renderInputDigest}`,
						durationMs: sql<number>`${artifact.durationMs}`,
						createdAt: sql<string>`${new Date().toISOString()}`,
					})
					.from(cornerClip)
					.innerJoin(
						drivingAnalysis,
						and(
							eq(drivingAnalysis.id, cornerClip.analysisId),
							eq(drivingAnalysis.workflowId, cornerClip.workflowId),
						),
					)
					.innerJoin(
						trackingRun,
						and(
							eq(trackingRun.id, cornerClip.runId),
							eq(trackingRun.workflowId, cornerClip.workflowId),
						),
					)
					.where(
						and(
							eq(cornerClip.id, clip.id),
							inArray(drivingAnalysis.status, [
								'running',
								'awaiting-reidentification',
							]),
							inArray(trackingRun.status, ['active', 'completed']),
						),
					),
			)
			.onConflictDoNothing();
		await this.list(clip.ownerId, clip.analysisId);
		const stored = await this.publication(clip.id);
		if (
			!stored ||
			stored.checksum !== artifact.checksumSha256 ||
			stored.renderInputDigest !== artifact.renderInputDigest ||
			stored.objectKey !== objectKey
		)
			throw new ClipAuthorityError('STALE_AUTHORITY');
	}

	async list(ownerId: string, analysisId: string) {
		const analysis = await this.database
			.select()
			.from(drivingAnalysis)
			.where(
				and(
					eq(drivingAnalysis.id, analysisId),
					eq(drivingAnalysis.ownerId, ownerId),
				),
			)
			.get();
		if (!analysis) throw new ClipAuthorityError('NOT_FOUND');
		if (analysis.status === 'deleted' || analysis.status === 'deleting')
			throw new ClipAuthorityError('DELETED');
		return this.database
			.select({
				clip: cornerClip,
				publication: cornerClipPublication,
				segmentId: cornerEvidenceBatch.segmentId,
			})
			.from(cornerClip)
			.innerJoin(
				drivingAnalysis,
				and(
					eq(drivingAnalysis.id, cornerClip.analysisId),
					eq(drivingAnalysis.workflowId, cornerClip.workflowId),
					eq(drivingAnalysis.ownerId, cornerClip.ownerId),
				),
			)
			.innerJoin(
				cornerEvidenceBatch,
				eq(cornerEvidenceBatch.artifactId, cornerClip.batchArtifactId),
			)
			.leftJoin(
				cornerClipPublication,
				eq(cornerClipPublication.clipId, cornerClip.id),
			)
			.where(
				and(
					eq(cornerClip.analysisId, analysisId),
					eq(cornerClip.ownerId, ownerId),
					eq(cornerClip.workflowId, analysis.workflowId),
					inArray(drivingAnalysis.status, [
						'queued',
						'running',
						'awaiting-reidentification',
						'completed',
						'failed',
						'cancelled',
					]),
				),
			);
	}

	async owned(ownerId: string, analysisId: string, clipId: string) {
		const rows = await this.list(ownerId, analysisId);
		const row = rows.find((value) => value.clip.id === clipId);
		if (!row) throw new ClipAuthorityError('NOT_FOUND');
		if (!row.publication) throw new ClipAuthorityError('NOT_READY');
		return { clip: row.clip, publication: row.publication };
	}
}
