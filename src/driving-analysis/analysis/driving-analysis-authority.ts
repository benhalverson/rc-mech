import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
	authRateLimit,
	car,
	driveSession,
	drivingAnalysis,
	raceVideo,
	raceVideoValidation,
	trackLayout,
	trackMapVersion,
} from '../../schema';
import { trackingRun } from '../tracking/authority-schema';
import type { PublicTrackingState } from '../tracking/authority-contracts';
import {
	createDrivingAnalysisInputSchema,
	DRIVING_ANALYSIS_CREATION_WINDOW_MS,
	type DrivingAnalysisWorkflowPayload,
	digestDrivingAnalysisCommand,
	digestFixedTrackViewLayout,
	drivingAnalysisWorkflowPayloadSchema,
	FIXED_TRACK_VIEW,
	MAX_ACTIVE_DRIVING_ANALYSES_PER_OWNER,
	MAX_DRIVING_ANALYSIS_CREATIONS_PER_HOUR,
	type PublicDrivingAnalysis,
} from './driving-analysis-contracts';

type DrivingAnalysisRecord = typeof drivingAnalysis.$inferSelect;

export type DrivingAnalysisAuthorityErrorCode =
	| 'CONFLICT'
	| 'INVALID_INPUT'
	| 'NOT_FOUND'
	| 'QUOTA_EXCEEDED'
	| 'RATE_LIMITED'
	| 'WORKFLOW_UNAVAILABLE';

export class DrivingAnalysisAuthorityError extends Error {
	readonly name = 'DrivingAnalysisAuthorityError';

	constructor(
		readonly code: DrivingAnalysisAuthorityErrorCode,
		message: string,
	) {
		super(message);
	}
}

export type CreateDrivingAnalysisCommand = Readonly<{
	ownerId: string;
	carId: string;
	driveSessionId: string;
	input: unknown;
}>;

export type DrivingAnalysisAuthorityOptions = Readonly<{
	clock?: () => Date;
	id?: () => string;
	startProcessing?: (payload: DrivingAnalysisWorkflowPayload) => Promise<void>;
}>;

export type DrivingAnalysisTransition =
	| Readonly<{
			kind: 'published' | 'replayed';
			analysis: PublicDrivingAnalysis;
	  }>
	| Readonly<{ kind: 'stale' }>;

export type DrivingAnalysisPreparationSource = Readonly<{
	objectKey: string;
	byteCount: number;
	checksumSha256: string;
}>;

const authorityError = (
	code: DrivingAnalysisAuthorityErrorCode,
	message: string,
) => new DrivingAnalysisAuthorityError(code, message);

const trackingAnalysisTarget = (
	state: PublicTrackingState,
	currentProgress: number,
): Readonly<{
	status: 'running' | 'awaiting-reidentification' | 'failed' | 'cancelled';
	progress: number;
}> => {
	if (state.lifecycle === 'awaiting-reidentification')
		return { status: 'awaiting-reidentification', progress: 99 };
	if (state.lifecycle === 'failed')
		return {
			status: 'failed',
			progress: Math.max(currentProgress, Math.min(state.progress, 99)),
		};
	if (state.lifecycle === 'cancelled')
		return {
			status: 'cancelled',
			progress: Math.max(currentProgress, Math.min(state.progress, 99)),
		};
	if (state.lifecycle === 'completed' || state.progress >= 99)
		return { status: 'running', progress: 99 };
	return {
		status: 'running',
		progress: Math.max(currentProgress, Math.max(21, state.progress)),
	};
};

const publicAnalysis = (
	record: DrivingAnalysisRecord,
): PublicDrivingAnalysis => ({
	id: record.id,
	requestId: record.requestId,
	carId: record.carId,
	driveSessionId: record.driveSessionId,
	raceVideoId: record.raceVideoId,
	raceWindow: {
		startTimestampMs: record.raceWindowStartMs,
		endTimestampMs: record.raceWindowEndMs,
	},
	approvedTrackMapVersionId: record.approvedTrackMapVersionId,
	subjectSeed: {
		timestampMs: record.subjectSeedTimestampMs,
		frameIndex: record.subjectSeedFrameIndex,
		identity: record.subjectSeedIdentity,
		box: {
			x: record.subjectBoxX,
			y: record.subjectBoxY,
			width: record.subjectBoxWidth,
			height: record.subjectBoxHeight,
		},
	},
	sourceLayout: {
		version: 'fixed-track-view.v1',
		digest: record.sourceLayoutDigest,
		width: record.sourceWidth,
		height: record.sourceHeight,
		trackView: FIXED_TRACK_VIEW,
	},
	lifecycle:
		record.status === 'awaiting-reidentification'
			? 'awaiting-reidentification'
			: record.status === 'failed'
				? 'failed'
				: /* c8 ignore next -- full completion is published by the later measurement/finalization slice. */ record.status ===
						'completed'
					? 'completed'
					: record.status === 'cancelled' ||
							record.status === 'deleting' ||
							record.status === 'deleted'
						? 'cancelled'
						: record.stage === 'preparation'
							? 'preparation'
							: record.stage === 'tracking' && record.progress >= 99
								? 'tracking-complete'
								: 'tracking',
	status: record.status,
	stage: record.stage,
	progress: record.progress,
	stateVersion: record.stateVersion,
	createdAt: record.createdAt,
	updatedAt: record.updatedAt,
});

export class DrivingAnalysisAuthority {
	private readonly database;
	private readonly clock: () => Date;
	private readonly id: () => string;
	private readonly startProcessing: (
		payload: DrivingAnalysisWorkflowPayload,
	) => Promise<void>;

	constructor(
		binding: D1Database,
		options: DrivingAnalysisAuthorityOptions = {},
	) {
		this.database = drizzle(binding);
		this.clock = options.clock ?? (() => new Date());
		this.id = options.id ?? (() => crypto.randomUUID());
		this.startProcessing = options.startProcessing ?? (async () => undefined);
	}

	async create(commandValue: CreateDrivingAnalysisCommand): Promise<{
		analysis: PublicDrivingAnalysis;
		created: boolean;
	}> {
		const parsed = createDrivingAnalysisInputSchema.safeParse(
			commandValue.input,
		);
		if (!parsed.success)
			throw authorityError('INVALID_INPUT', 'Invalid Driving-analysis input');
		const command = { ...commandValue, input: parsed.data };
		const requestDigest = await digestDrivingAnalysisCommand(command);
		const replay = await this.findRequest(
			command.ownerId,
			parsed.data.requestId,
		);
		if (replay) return this.replay(replay, requestDigest);

		await this.requireActiveDrive(
			command.ownerId,
			command.carId,
			command.driveSessionId,
		);
		const source = await this.requireReadyRaceVideo(
			command.ownerId,
			command.carId,
			command.driveSessionId,
			parsed.data.raceVideoId,
		);
		if (parsed.data.raceWindow.endTimestampMs > source.durationMs)
			throw authorityError(
				'INVALID_INPUT',
				'Race window must stay inside the ready Race recording',
			);
		await this.requireApprovedTrackMap(parsed.data.approvedTrackMapVersionId);
		await this.requireOwnerWithinAnalysisQuota(command.ownerId);
		await this.consumeCreationPermit(command.ownerId);

		const analysisId = this.id();
		const timestamp = this.clock().toISOString();
		const sourceLayoutDigest = await digestFixedTrackViewLayout(
			source.width,
			source.height,
		);
		let record: DrivingAnalysisRecord;
		try {
			record = (await this.database
				.insert(drivingAnalysis)
				.values({
					id: analysisId,
					ownerId: command.ownerId,
					requestId: parsed.data.requestId,
					requestDigest,
					carId: command.carId,
					driveSessionId: command.driveSessionId,
					raceVideoId: parsed.data.raceVideoId,
					raceWindowStartMs: parsed.data.raceWindow.startTimestampMs,
					raceWindowEndMs: parsed.data.raceWindow.endTimestampMs,
					approvedTrackMapVersionId: parsed.data.approvedTrackMapVersionId,
					subjectSeedTimestampMs: parsed.data.subjectSeed.timestampMs,
					subjectSeedFrameIndex: parsed.data.subjectSeed.frameIndex,
					subjectSeedIdentity: parsed.data.subjectSeed.identity,
					subjectBoxX: parsed.data.subjectSeed.box.x,
					subjectBoxY: parsed.data.subjectSeed.box.y,
					subjectBoxWidth: parsed.data.subjectSeed.box.width,
					subjectBoxHeight: parsed.data.subjectSeed.box.height,
					sourceLayoutVersion: 'fixed-track-view.v1',
					sourceLayoutDigest,
					sourceWidth: source.width,
					sourceHeight: source.height,
					workflowId: analysisId,
					status: 'queued',
					stage: 'preparation',
					progress: 0,
					stateVersion: 1,
					createdAt: timestamp,
					updatedAt: timestamp,
				})
				.returning()
				.get()) as DrivingAnalysisRecord;
		} catch {
			const raced = await this.findRequest(
				command.ownerId,
				parsed.data.requestId,
			);
			if (raced) return this.replay(raced, requestDigest);
			await this.requireOwnerWithinAnalysisQuota(command.ownerId);
			throw authorityError('CONFLICT', 'Driving analysis could not be created');
		}
		await this.start(record);
		return { analysis: publicAnalysis(record), created: true };
	}

	async get(
		ownerId: string,
		analysisId: string,
	): Promise<PublicDrivingAnalysis> {
		const record = await this.find(ownerId, analysisId);
		if (!record)
			throw authorityError('NOT_FOUND', 'Driving analysis not found');
		return publicAnalysis(record);
	}

	async preparationSource(
		ownerId: string,
		analysisId: string,
	): Promise<DrivingAnalysisPreparationSource> {
		const record = await this.database
			.select({
				objectKey: raceVideo.objectKey,
				byteCount: raceVideoValidation.byteCount,
				checksumSha256: raceVideoValidation.checksumSha256,
			})
			.from(drivingAnalysis)
			.innerJoin(raceVideo, eq(raceVideo.id, drivingAnalysis.raceVideoId))
			.innerJoin(
				raceVideoValidation,
				eq(raceVideoValidation.raceVideoId, raceVideo.id),
			)
			.where(
				and(
					eq(drivingAnalysis.ownerId, ownerId),
					eq(drivingAnalysis.id, analysisId),
					eq(raceVideo.ownerId, ownerId),
					eq(raceVideo.status, 'validating'),
					eq(raceVideoValidation.status, 'ready'),
				),
			)
			.get();
		if (
			!record ||
			!Number.isSafeInteger(record.byteCount) ||
			!record.checksumSha256
		)
			throw authorityError(
				'CONFLICT',
				'Validated Race recording media facts are incomplete',
			);
		return {
			objectKey: record.objectKey,
			byteCount: record.byteCount,
			checksumSha256: record.checksumSha256,
		};
	}

	async beginPreparation(
		payloadValue: DrivingAnalysisWorkflowPayload,
		workflowId: string,
		updatedAt: string,
	): Promise<DrivingAnalysisTransition> {
		const payload = drivingAnalysisWorkflowPayloadSchema.parse(payloadValue);
		if (!(await this.hasCurrentWorkflowInput(payload, workflowId)))
			return { kind: 'stale' };
		let published: DrivingAnalysisRecord | undefined;
		try {
			published = await this.database
				.update(drivingAnalysis)
				.set({
					status: 'running',
					stage: 'preparation',
					progress: 0,
					stateVersion: payload.expectedStateVersion + 1,
					updatedAt,
				})
				.where(
					and(
						eq(drivingAnalysis.id, payload.analysisId),
						eq(drivingAnalysis.ownerId, payload.ownerId),
						eq(drivingAnalysis.workflowId, workflowId),
						eq(drivingAnalysis.stateVersion, payload.expectedStateVersion),
						eq(drivingAnalysis.status, 'queued'),
					),
				)
				.returning()
				.get();
		} catch {
			throw authorityError('CONFLICT', 'Driving-analysis state is stale');
		}
		if (published)
			return { kind: 'published', analysis: publicAnalysis(published) };
		return this.replayedTransition(payload, workflowId, 0);
	}

	async publishPreparationProgress(
		payloadValue: DrivingAnalysisWorkflowPayload,
		workflowId: string,
		progress: number,
		updatedAt: string,
	): Promise<DrivingAnalysisTransition> {
		const payload = drivingAnalysisWorkflowPayloadSchema.parse(payloadValue);
		if (!(await this.hasCurrentWorkflowInput(payload, workflowId)))
			return { kind: 'stale' };
		if (!Number.isInteger(progress) || progress < 1 || progress > 99)
			throw authorityError(
				'INVALID_INPUT',
				'Driving-analysis progress is invalid',
			);
		let published: DrivingAnalysisRecord | undefined;
		try {
			published = await this.database
				.update(drivingAnalysis)
				.set({
					status: 'running',
					stage: 'preparation',
					progress,
					stateVersion: payload.expectedStateVersion + 1,
					updatedAt,
				})
				.where(
					and(
						eq(drivingAnalysis.id, payload.analysisId),
						eq(drivingAnalysis.ownerId, payload.ownerId),
						eq(drivingAnalysis.workflowId, workflowId),
						eq(drivingAnalysis.stateVersion, payload.expectedStateVersion),
						eq(drivingAnalysis.status, 'running'),
						eq(drivingAnalysis.stage, 'preparation'),
					),
				)
				.returning()
				.get();
		} catch {
			throw authorityError('CONFLICT', 'Driving-analysis progress is stale');
		}
		if (published)
			return { kind: 'published', analysis: publicAnalysis(published) };
		return this.replayedTransition(payload, workflowId, progress);
	}

	async publishTrackingStart(
		payloadValue: DrivingAnalysisWorkflowPayload,
		workflowId: string,
		expectedStateVersion: number,
		updatedAt: string,
	): Promise<DrivingAnalysisTransition> {
		const payload = drivingAnalysisWorkflowPayloadSchema.parse(payloadValue);
		if (!(await this.hasCurrentWorkflowInput(payload, workflowId)))
			return { kind: 'stale' };
		const published = await this.database
			.update(drivingAnalysis)
			.set({
				status: 'running',
				stage: 'tracking',
				progress: 21,
				stateVersion: expectedStateVersion + 1,
				updatedAt,
			})
			.where(
				and(
					eq(drivingAnalysis.id, payload.analysisId),
					eq(drivingAnalysis.ownerId, payload.ownerId),
					eq(drivingAnalysis.workflowId, workflowId),
					eq(drivingAnalysis.stateVersion, expectedStateVersion),
					eq(drivingAnalysis.status, 'running'),
					eq(drivingAnalysis.stage, 'preparation'),
				),
			)
			.returning()
			.get();
		if (published)
			return { kind: 'published', analysis: publicAnalysis(published) };
		return this.replayedTransition(payload, workflowId, 21);
	}

	async publishTrackingState(
		ownerId: string,
		analysisId: string,
		state: PublicTrackingState,
		updatedAt: string,
	): Promise<DrivingAnalysisTransition> {
		const run = await this.database
			.select({ id: trackingRun.id })
			.from(trackingRun)
			.where(
				and(
					eq(trackingRun.id, state.runId),
					eq(trackingRun.ownerId, ownerId),
					eq(trackingRun.analysisId, analysisId),
				),
			)
			.get();
		if (!run) return { kind: 'stale' };
		const current = await this.find(ownerId, analysisId);
		/* c8 ignore next -- a Tracking run linked to a missing analysis is corruption defense. */
		if (!current || current.stage !== 'tracking') return { kind: 'stale' };
		const target = trackingAnalysisTarget(state, current.progress);
		if (
			current.status === target.status &&
			current.progress === target.progress
		)
			return { kind: 'replayed', analysis: publicAnalysis(current) };
		if (
			current.status !== 'running' &&
			current.status !== 'awaiting-reidentification'
		)
			return { kind: 'stale' };
		const published = await this.database
			.update(drivingAnalysis)
			.set({
				status: target.status,
				progress: target.progress,
				stateVersion: current.stateVersion + 1,
				updatedAt,
			})
			.where(
				and(
					eq(drivingAnalysis.id, analysisId),
					eq(drivingAnalysis.ownerId, ownerId),
					eq(drivingAnalysis.stateVersion, current.stateVersion),
					eq(drivingAnalysis.stage, 'tracking'),
				),
			)
			.returning()
			.get();
		/* c8 ignore next 2 -- the optimistic write can miss only under a concurrent authority transition. */
		return published
			? { kind: 'published', analysis: publicAnalysis(published) }
			: { kind: 'stale' };
	}

	private async replay(
		record: DrivingAnalysisRecord,
		requestDigest: string,
	): Promise<{ analysis: PublicDrivingAnalysis; created: false }> {
		if (record.requestDigest !== requestDigest)
			throw authorityError(
				'CONFLICT',
				'Client request identity was reused with different analysis input',
			);
		await this.start(record);
		return { analysis: publicAnalysis(record), created: false };
	}

	private async start(record: DrivingAnalysisRecord): Promise<void> {
		try {
			await this.startProcessing({
				kind: 'analysis-creation.v1',
				ownerId: record.ownerId,
				analysisId: record.id,
				expectedStateVersion: record.stateVersion,
			});
		} catch {
			throw authorityError(
				'WORKFLOW_UNAVAILABLE',
				'Driving-analysis processing is unavailable',
			);
		}
	}

	private async replayedTransition(
		payload: DrivingAnalysisWorkflowPayload,
		workflowId: string,
		minimumProgress: number,
	): Promise<DrivingAnalysisTransition> {
		const current = await this.findWorkflow(
			payload.ownerId,
			payload.analysisId,
			workflowId,
		);
		if (!current) return { kind: 'stale' };
		if (
			current.stateVersion > payload.expectedStateVersion &&
			current.progress >= minimumProgress
		)
			return { kind: 'replayed', analysis: publicAnalysis(current) };
		return { kind: 'stale' };
	}

	private findWorkflow(
		ownerId: string,
		analysisId: string,
		workflowId: string,
	) {
		return this.database
			.select()
			.from(drivingAnalysis)
			.where(
				and(
					eq(drivingAnalysis.ownerId, ownerId),
					eq(drivingAnalysis.id, analysisId),
					eq(drivingAnalysis.workflowId, workflowId),
				),
			)
			.get();
	}

	private async hasCurrentWorkflowInput(
		payload: DrivingAnalysisWorkflowPayload,
		workflowId: string,
	): Promise<boolean> {
		const record = await this.database
			.select({ id: drivingAnalysis.id })
			.from(drivingAnalysis)
			.innerJoin(car, eq(car.id, drivingAnalysis.carId))
			.innerJoin(
				driveSession,
				eq(driveSession.id, drivingAnalysis.driveSessionId),
			)
			.innerJoin(raceVideo, eq(raceVideo.id, drivingAnalysis.raceVideoId))
			.innerJoin(
				raceVideoValidation,
				eq(raceVideoValidation.raceVideoId, raceVideo.id),
			)
			.innerJoin(
				trackMapVersion,
				eq(trackMapVersion.id, drivingAnalysis.approvedTrackMapVersionId),
			)
			.innerJoin(trackLayout, eq(trackLayout.id, trackMapVersion.layoutId))
			.where(
				and(
					eq(drivingAnalysis.id, payload.analysisId),
					eq(drivingAnalysis.ownerId, payload.ownerId),
					eq(drivingAnalysis.workflowId, workflowId),
					eq(car.ownerId, payload.ownerId),
					isNull(car.archivedAt),
					isNull(driveSession.deletedAt),
					eq(raceVideo.ownerId, payload.ownerId),
					eq(raceVideo.carId, drivingAnalysis.carId),
					eq(raceVideo.driveSessionId, drivingAnalysis.driveSessionId),
					eq(raceVideo.status, 'validating'),
					eq(raceVideoValidation.status, 'ready'),
					sql`${raceVideoValidation.durationMs} >= ${drivingAnalysis.raceWindowEndMs}`,
					sql`${raceVideoValidation.width} = ${drivingAnalysis.sourceWidth}`,
					sql`${raceVideoValidation.height} = ${drivingAnalysis.sourceHeight}`,
					eq(trackMapVersion.status, 'approved'),
					eq(trackLayout.status, 'active'),
				),
			)
			.get();
		return record !== undefined;
	}

	private find(ownerId: string, analysisId: string) {
		return this.database
			.select()
			.from(drivingAnalysis)
			.where(
				and(
					eq(drivingAnalysis.ownerId, ownerId),
					eq(drivingAnalysis.id, analysisId),
				),
			)
			.get();
	}

	private findRequest(ownerId: string, requestId: string) {
		return this.database
			.select()
			.from(drivingAnalysis)
			.where(
				and(
					eq(drivingAnalysis.ownerId, ownerId),
					eq(drivingAnalysis.requestId, requestId),
				),
			)
			.get();
	}

	private async requireActiveDrive(
		ownerId: string,
		carId: string,
		driveSessionId: string,
	): Promise<void> {
		const record = await this.database
			.select({ id: driveSession.id })
			.from(driveSession)
			.innerJoin(car, eq(car.id, driveSession.carId))
			.where(
				and(
					eq(car.id, carId),
					eq(car.ownerId, ownerId),
					isNull(car.archivedAt),
					eq(driveSession.id, driveSessionId),
					isNull(driveSession.deletedAt),
				),
			)
			.get();
		if (!record)
			throw authorityError('NOT_FOUND', 'Car or Drive session not found');
	}

	private async requireReadyRaceVideo(
		ownerId: string,
		carId: string,
		driveSessionId: string,
		raceVideoId: string,
	): Promise<{ durationMs: number; width: number; height: number }> {
		const record = await this.database
			.select({
				ownerId: raceVideo.ownerId,
				carId: raceVideo.carId,
				driveSessionId: raceVideo.driveSessionId,
				videoStatus: sql<string>`${raceVideo.status}`.as('video_status'),
				validationStatus: sql<string>`${raceVideoValidation.status}`.as(
					'validation_status',
				),
				durationMs: raceVideoValidation.durationMs,
				width: raceVideoValidation.width,
				height: raceVideoValidation.height,
			})
			.from(raceVideo)
			.leftJoin(
				raceVideoValidation,
				eq(raceVideoValidation.raceVideoId, raceVideo.id),
			)
			.where(eq(raceVideo.id, raceVideoId))
			.get();
		if (!record || record.ownerId !== ownerId)
			throw authorityError('NOT_FOUND', 'Race recording not found');
		if (
			record.carId !== carId ||
			record.driveSessionId !== driveSessionId ||
			record.videoStatus !== 'validating' ||
			record.validationStatus !== 'ready'
		)
			throw authorityError(
				'CONFLICT',
				'A ready Race recording for this Drive session is required',
			);
		return {
			durationMs: record.durationMs as number,
			width: record.width as number,
			height: record.height as number,
		};
	}

	private async requireApprovedTrackMap(versionId: string): Promise<void> {
		const record = await this.database
			.select({ id: trackMapVersion.id })
			.from(trackMapVersion)
			.innerJoin(trackLayout, eq(trackLayout.id, trackMapVersion.layoutId))
			.where(
				and(
					eq(trackMapVersion.id, versionId),
					eq(trackMapVersion.status, 'approved'),
					eq(trackLayout.status, 'active'),
				),
			)
			.get();
		if (!record)
			throw authorityError(
				'CONFLICT',
				'An approved Track-map version on an active layout is required',
			);
	}

	private async requireOwnerWithinAnalysisQuota(
		ownerId: string,
	): Promise<void> {
		const active = await this.database
			.select({ id: drivingAnalysis.id })
			.from(drivingAnalysis)
			.where(
				and(
					eq(drivingAnalysis.ownerId, ownerId),
					inArray(drivingAnalysis.status, [
						'queued',
						'running',
						'awaiting-reidentification',
					]),
				),
			)
			.limit(MAX_ACTIVE_DRIVING_ANALYSES_PER_OWNER);
		if (active.length >= MAX_ACTIVE_DRIVING_ANALYSES_PER_OWNER)
			throw authorityError(
				'QUOTA_EXCEEDED',
				'Active Driving-analysis quota has been reached',
			);
	}

	private async consumeCreationPermit(ownerId: string): Promise<void> {
		const key = `driving-analysis:${ownerId}`;
		const now = this.clock().getTime();
		const expiredBefore = now - DRIVING_ANALYSIS_CREATION_WINDOW_MS;
		const updated = await this.database
			.insert(authRateLimit)
			.values({ key, windowStartedAt: now, count: 1 })
			.onConflictDoUpdate({
				target: authRateLimit.key,
				set: {
					count: sql<number>`CASE WHEN ${authRateLimit.windowStartedAt} <= ${expiredBefore} THEN 1 ELSE ${authRateLimit.count} + 1 END`,
					windowStartedAt: sql<number>`CASE WHEN ${authRateLimit.windowStartedAt} <= ${expiredBefore} THEN ${now} ELSE ${authRateLimit.windowStartedAt} END`,
				},
			})
			.returning({ count: authRateLimit.count })
			.get();
		if (!updated || updated.count > MAX_DRIVING_ANALYSIS_CREATIONS_PER_HOUR)
			throw authorityError(
				'RATE_LIMITED',
				'Too many Driving analyses were created recently',
			);
	}
}
