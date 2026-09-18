import { and, eq, exists, inArray, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { drivingAnalysis, raceVideo, raceVideoValidation } from '../../schema';
import { cornerClipObjectKey } from '../clips/clip-object-key';
import { cornerClip } from '../clips/clip-schema';
import {
	preparedTrackingObject,
	subjectObservationArtifact,
	trackingArtifactPromotion,
	trackingExecutionAttempt,
	trackingRun,
	trackingSegment,
	trackingTransferRequest,
} from '../tracking/authority-schema';
import { preparedObjectKeys } from '../tracking/prepared-object-keys';
import { DrivingAnalysisAuthorityError } from './driving-analysis-authority';
import type { DrivingAnalysisWorkflowPayload } from './driving-analysis-contracts';
import { analysisDeletion, preparationIntent } from './lifecycle-schema';

type Options = Readonly<{
	binding: D1Database;
	bucket: R2Bucket;
	clock?: () => Date;
	startCancellation: (payload: DrivingAnalysisWorkflowPayload) => Promise<void>;
}>;

export function createAnalysisLifecycle(options: Options) {
	const database = drizzle(options.binding);
	const clock = options.clock ?? (() => new Date());
	const find = async (ownerId: string, analysisId: string) => {
		const record = await database
			.select()
			.from(drivingAnalysis)
			.where(
				and(
					eq(drivingAnalysis.ownerId, ownerId),
					eq(drivingAnalysis.id, analysisId),
				),
			)
			.get();
		if (!record)
			throw new DrivingAnalysisAuthorityError(
				'NOT_FOUND',
				'Driving analysis not found',
			);
		return record;
	};
	const get = async (ownerId: string, analysisId: string) => {
		const record = await find(ownerId, analysisId);
		let failure: { code: string; retryable: boolean } | null = null;
		let canRetry = false;
		if (['failed', 'completed'].includes(record.status)) {
			const source = await database
				.select({ id: raceVideo.id })
				.from(raceVideo)
				.innerJoin(
					raceVideoValidation,
					eq(raceVideoValidation.raceVideoId, raceVideo.id),
				)
				.where(
					and(
						eq(raceVideo.id, record.raceVideoId),
						eq(raceVideo.ownerId, ownerId),
						eq(raceVideo.status, 'validating'),
						eq(raceVideoValidation.status, 'ready'),
					),
				)
				.get();
			const run = await database
				.select({ code: trackingRun.safeFailureCode })
				.from(trackingRun)
				.where(
					and(
						eq(trackingRun.ownerId, ownerId),
						eq(trackingRun.workflowId, record.workflowId),
					),
				)
				.get();
			const terminal = run?.code === 'TRACKING_ARTIFACT_INVALID';
			canRetry = !!source && !terminal;
			if (!source) failure = { code: 'SOURCE_UNAVAILABLE', retryable: false };
			else if (record.status === 'failed')
				failure = {
					code: terminal ? 'PROCESSING_REJECTED' : 'PROCESSING_UNAVAILABLE',
					retryable: !terminal,
				};
		}
		return {
			analysisId,
			status: record.status,
			stateVersion: record.stateVersion,
			permanent: record.status === 'deleted',
			canCancel: ['queued', 'running', 'awaiting-reidentification'].includes(
				record.status,
			),
			canRetry,
			failure,
		};
	};
	const remove = async (
		command: Readonly<{
			ownerId: string;
			analysisId: string;
			expectedStateVersion: number;
		}>,
	) => {
		const { ownerId, analysisId, expectedStateVersion } = command;
		const current = await find(ownerId, analysisId);
		if (current.status === 'deleted') return get(ownerId, analysisId);
		if (current.status !== 'deleting') {
			if (current.stateVersion !== expectedStateVersion)
				throw new DrivingAnalysisAuthorityError(
					'CONFLICT',
					'Driving analysis changed; reload and retry',
				);
			const timestamp = clock().toISOString();
			const witness = and(
				eq(drivingAnalysis.id, analysisId),
				eq(drivingAnalysis.ownerId, ownerId),
				eq(drivingAnalysis.stateVersion, expectedStateVersion),
			);
			const [, rows] = await database.batch([
				database
					.update(trackingRun)
					.set({
						status: 'cancelled',
						version: sql`${trackingRun.version} + 1`,
						completedAt: timestamp,
					})
					.where(
						and(
							eq(trackingRun.ownerId, ownerId),
							eq(trackingRun.analysisId, analysisId),
							eq(trackingRun.status, 'active'),
							exists(
								database
									.select({ id: drivingAnalysis.id })
									.from(drivingAnalysis)
									.where(witness),
							),
						),
					),
				database
					.update(drivingAnalysis)
					.set({
						status: 'deleting',
						stateVersion: expectedStateVersion + 1,
						updatedAt: timestamp,
					})
					.where(witness)
					.returning(),
				database
					.insert(analysisDeletion)
					.select(
						database
							.select({
								ownerId: drivingAnalysis.ownerId,
								analysisId: drivingAnalysis.id,
								requestedAt: sql<string>`${timestamp}`.as('requested_at'),
								deletedAt: sql<string>`NULL`.as('deleted_at'),
								nextCleanupAt: sql<string>`${timestamp}`.as('next_cleanup_at'),
							})
							.from(drivingAnalysis)
							.where(
								and(
									eq(drivingAnalysis.id, analysisId),
									eq(drivingAnalysis.ownerId, ownerId),
									eq(drivingAnalysis.status, 'deleting'),
									eq(drivingAnalysis.stateVersion, expectedStateVersion + 1),
								),
							),
					)
					.onConflictDoNothing(),
			]);
			if (!rows[0])
				throw new DrivingAnalysisAuthorityError(
					'CONFLICT',
					'Driving analysis changed; reload and retry',
				);
		}
		try {
			await options.startCancellation({
				kind: 'analysis-creation.v1',
				cancellation: true,
				ownerId,
				analysisId,
				workflowId: current.workflowId,
				workflowSequence: current.workflowSequence,
				expectedStateVersion,
			});
		} catch {
			throw new DrivingAnalysisAuthorityError(
				'WORKFLOW_UNAVAILABLE',
				'Driving-analysis deletion is pending; retry deletion',
			);
		}
		return get(ownerId, analysisId);
	};
	const cleanup = async (limit: number) => {
		const timestamp = clock().toISOString();
		const candidates = await database
			.select()
			.from(analysisDeletion)
			.where(lte(analysisDeletion.nextCleanupAt, timestamp))
			.limit(limit);
		return Promise.allSettled(
			candidates.map(async (candidate) => {
				if (!candidate.deletedAt) {
					const record = await find(candidate.ownerId, candidate.analysisId);
					await options.startCancellation({
						kind: 'analysis-creation.v1',
						cancellation: true,
						ownerId: candidate.ownerId,
						analysisId: candidate.analysisId,
						workflowId: record.workflowId,
						workflowSequence: record.workflowSequence,
						expectedStateVersion: record.stateVersion,
					});
				}
				const runs = database
					.select({ id: trackingRun.id })
					.from(trackingRun)
					.where(
						and(
							eq(trackingRun.ownerId, candidate.ownerId),
							eq(trackingRun.analysisId, candidate.analysisId),
						),
					);
				const [prepared, accepted, promotions, intents, clips, transfers] =
					await Promise.all([
						database
							.select({ key: preparedTrackingObject.objectKey })
							.from(preparedTrackingObject)
							.where(inArray(preparedTrackingObject.runId, runs)),
						database
							.select({ key: subjectObservationArtifact.acceptedObjectKey })
							.from(subjectObservationArtifact)
							.where(inArray(subjectObservationArtifact.runId, runs)),
						database
							.select({
								staging: trackingArtifactPromotion.stagingObjectKey,
								accepted: trackingArtifactPromotion.acceptedObjectKey,
							})
							.from(trackingArtifactPromotion)
							.where(inArray(trackingArtifactPromotion.runId, runs)),
						database
							.select()
							.from(preparationIntent)
							.where(
								and(
									eq(preparationIntent.ownerId, candidate.ownerId),
									inArray(preparationIntent.runId, runs),
								),
							),
						database
							.select({
								runId: cornerClip.runId,
								digest: cornerClip.inputDigest,
							})
							.from(cornerClip)
							.where(
								and(
									eq(cornerClip.ownerId, candidate.ownerId),
									eq(cornerClip.analysisId, candidate.analysisId),
								),
							),
						database
							.select({
								attemptId: trackingTransferRequest.attemptId,
								id: trackingTransferRequest.id,
							})
							.from(trackingTransferRequest)
							.innerJoin(
								trackingExecutionAttempt,
								eq(
									trackingExecutionAttempt.id,
									trackingTransferRequest.attemptId,
								),
							)
							.innerJoin(
								trackingSegment,
								eq(trackingSegment.id, trackingExecutionAttempt.segmentId),
							)
							.where(
								and(
									inArray(trackingSegment.runId, runs),
									eq(trackingTransferRequest.role, 'observation-artifact'),
								),
							),
					]);
				const keys = [
					...new Set([
						...prepared.map((row) => row.key),
						...accepted.map((row) => row.key),
						...promotions.flatMap((row) => [row.staging, row.accepted]),
						...intents.flatMap((row) =>
							preparedObjectKeys(row.preparedMediaId),
						),
						...clips.map((row) =>
							cornerClipObjectKey({
								ownerId: candidate.ownerId,
								analysisId: candidate.analysisId,
								runId: row.runId,
								inputDigest: row.digest,
							}),
						),
						...transfers.map(
							(row) =>
								`tracking-staging/${row.attemptId}/${row.id}/subject-observations.json.gz`,
						),
					]),
				];
				for (const key of keys) await options.bucket.delete(key);
				await database.batch([
					database
						.update(drivingAnalysis)
						.set({
							status: 'deleted',
							stateVersion: sql`${drivingAnalysis.stateVersion} + 1`,
							updatedAt: timestamp,
						})
						.where(
							and(
								eq(drivingAnalysis.ownerId, candidate.ownerId),
								eq(drivingAnalysis.id, candidate.analysisId),
								eq(drivingAnalysis.status, 'deleting'),
							),
						),
					database
						.update(analysisDeletion)
						.set({
							deletedAt: candidate.deletedAt ?? timestamp,
							nextCleanupAt: new Date(
								clock().getTime() + 86_400_000,
							).toISOString(),
						})
						.where(
							and(
								eq(analysisDeletion.ownerId, candidate.ownerId),
								eq(analysisDeletion.analysisId, candidate.analysisId),
							),
						),
				]);
			}),
		);
	};
	return { get, remove, cleanup };
}
