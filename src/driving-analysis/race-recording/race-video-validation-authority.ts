import { and, eq, exists, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
	drivingAnalysis,
	raceVideo,
	raceVideoValidation,
	trackingRun,
	trackingRunInput,
} from '../../schema';
import {
	type RaceVideoMediaFacts,
	type RaceVideoValidationResponse,
	type RaceVideoValidationSafeError,
	type RaceVideoValidationWorkflowPayload,
	raceVideoMediaFactsSchema,
	raceVideoValidationSafeErrorSchema,
} from './race-video-validation-contracts';

type ValidationRecord = typeof raceVideoValidation.$inferSelect;

export type RaceVideoValidationContext =
	| Readonly<{
			kind: 'pending';
			ownerId: string;
			recordingId: string;
			validationId: string;
			stateVersion: number;
			objectKey: string;
			expectedByteCount: number;
	  }>
	| Readonly<{ kind: 'terminal'; status: 'ready' | 'invalid' }>
	| Readonly<{ kind: 'stale' }>;

export type PublicRaceVideoValidation = Readonly<{
	status: 'validating' | 'ready' | 'invalid';
	stateVersion: number;
	media: RaceVideoMediaFacts | null;
	error: RaceVideoValidationSafeError | null;
	validatedAt: string | null;
}>;

const parseStringArray = (value: string | null): string[] | null => {
	/* c8 ignore next -- ready-row D1 constraint requires both JSON columns. */
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) &&
			parsed.every((item) => typeof item === 'string')
			? parsed
			: null;
	} catch {
		return null;
	}
};

const mediaFacts = (record: ValidationRecord): RaceVideoMediaFacts | null => {
	if (record.status !== 'ready') return null;
	const candidate = {
		byteCount: record.byteCount,
		durationMs: record.durationMs,
		width: record.width,
		height: record.height,
		videoCodec: record.videoCodec,
		audioCodecs: parseStringArray(record.audioCodecsJson),
		containerFormats: parseStringArray(record.containerFormatsJson),
		decodedFrameCount: record.decodedFrameCount,
		averageFrameRate: {
			numerator: record.averageFrameRateNumerator,
			denominator: record.averageFrameRateDenominator,
		},
		timeBase: {
			numerator: record.timeBaseNumerator,
			denominator: record.timeBaseDenominator,
		},
		sampleAspectRatio: {
			numerator: record.sampleAspectRatioNumerator,
			denominator: record.sampleAspectRatioDenominator,
		},
		displayAspectRatio: {
			numerator: record.displayAspectRatioNumerator,
			denominator: record.displayAspectRatioDenominator,
		},
		startTimeMs: record.startTimeMs,
		checksumSha256: record.checksumSha256,
	};
	const parsed = raceVideoMediaFactsSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
};

export class RaceVideoValidationAuthority {
	private readonly database;

	constructor(binding: D1Database) {
		this.database = drizzle(binding);
	}

	async ensure(
		recordingId: string,
		startedAt: string,
	): Promise<RaceVideoValidationWorkflowPayload> {
		await this.database
			.insert(raceVideoValidation)
			.values({
				raceVideoId: recordingId,
				validationId: recordingId,
				status: 'pending',
				stateVersion: 1,
				startedAt,
				updatedAt: startedAt,
				completedAt: null,
			})
			.onConflictDoNothing({ target: raceVideoValidation.raceVideoId });
		const current = await this.database
			.select({
				ownerId: raceVideo.ownerId,
				recordingId: raceVideo.id,
				validationId: raceVideoValidation.validationId,
				stateVersion: raceVideoValidation.stateVersion,
			})
			.from(raceVideoValidation)
			.innerJoin(raceVideo, eq(raceVideo.id, raceVideoValidation.raceVideoId))
			.where(eq(raceVideoValidation.raceVideoId, recordingId))
			.get();
		if (!current)
			throw new Error('Race-video validation could not be persisted');
		return {
			ownerId: current.ownerId,
			recordingId: current.recordingId,
			validationId: current.validationId,
			expectedStateVersion: current.stateVersion,
		};
	}

	async context(
		payload: RaceVideoValidationWorkflowPayload,
	): Promise<RaceVideoValidationContext> {
		const validation = await this.database
			.select()
			.from(raceVideoValidation)
			.where(
				and(
					eq(raceVideoValidation.raceVideoId, payload.recordingId),
					eq(raceVideoValidation.validationId, payload.validationId),
				),
			)
			.get();
		if (!validation) return { kind: 'stale' };
		if (validation.status !== 'pending')
			return { kind: 'terminal', status: validation.status };
		const recording = await this.database
			.select()
			.from(raceVideo)
			.where(
				and(
					eq(raceVideo.id, payload.recordingId),
					eq(raceVideo.ownerId, payload.ownerId),
				),
			)
			.get();
		if (
			recording?.status !== 'validating' ||
			validation.stateVersion !== payload.expectedStateVersion ||
			recording.actualSize === null
		)
			return { kind: 'stale' };
		return {
			kind: 'pending',
			ownerId: recording.ownerId,
			recordingId: recording.id,
			validationId: validation.validationId,
			stateVersion: validation.stateVersion,
			objectKey: recording.objectKey,
			expectedByteCount: recording.actualSize,
		};
	}

	async publish(
		payload: RaceVideoValidationWorkflowPayload,
		response: RaceVideoValidationResponse,
		completedAt: string,
	): Promise<'published' | 'replayed' | 'stale'> {
		const values =
			response.outcome === 'accepted'
				? {
						status: 'ready' as const,
						stateVersion: payload.expectedStateVersion + 1,
						byteCount: response.media.byteCount,
						durationMs: response.media.durationMs,
						width: response.media.width,
						height: response.media.height,
						videoCodec: response.media.videoCodec,
						audioCodecsJson: JSON.stringify(response.media.audioCodecs),
						containerFormatsJson: JSON.stringify(
							response.media.containerFormats,
						),
						decodedFrameCount: response.media.decodedFrameCount,
						averageFrameRateNumerator:
							response.media.averageFrameRate.numerator,
						averageFrameRateDenominator:
							response.media.averageFrameRate.denominator,
						timeBaseNumerator: response.media.timeBase.numerator,
						timeBaseDenominator: response.media.timeBase.denominator,
						sampleAspectRatioNumerator:
							response.media.sampleAspectRatio.numerator,
						sampleAspectRatioDenominator:
							response.media.sampleAspectRatio.denominator,
						displayAspectRatioNumerator:
							response.media.displayAspectRatio.numerator,
						displayAspectRatioDenominator:
							response.media.displayAspectRatio.denominator,
						startTimeMs: response.media.startTimeMs,
						checksumSha256: response.media.checksumSha256,
						errorCode: null,
						errorStage: null,
						errorMessage: null,
						updatedAt: completedAt,
						completedAt,
					}
				: {
						status: 'invalid' as const,
						stateVersion: payload.expectedStateVersion + 1,
						errorCode: response.error.code,
						errorStage: response.error.stage,
						errorMessage: response.error.message,
						updatedAt: completedAt,
						completedAt,
					};
		const published = await this.database
			.update(raceVideoValidation)
			.set(values)
			.where(
				and(
					eq(raceVideoValidation.raceVideoId, payload.recordingId),
					eq(raceVideoValidation.validationId, payload.validationId),
					eq(raceVideoValidation.status, 'pending'),
					eq(raceVideoValidation.stateVersion, payload.expectedStateVersion),
					exists(
						this.database
							.select({ id: raceVideo.id })
							.from(raceVideo)
							.where(
								and(
									eq(raceVideo.id, payload.recordingId),
									eq(raceVideo.ownerId, payload.ownerId),
									eq(raceVideo.status, 'validating'),
								),
							),
					),
				),
			)
			.returning({ status: raceVideoValidation.status })
			.get();
		if (published) return 'published';
		const current = await this.database
			.select({ status: raceVideoValidation.status })
			.from(raceVideoValidation)
			.where(
				and(
					eq(raceVideoValidation.raceVideoId, payload.recordingId),
					eq(raceVideoValidation.validationId, payload.validationId),
				),
			)
			.get();
		return current?.status === 'ready' || current?.status === 'invalid'
			? 'replayed'
			: 'stale';
	}

	async public(recordingId: string): Promise<PublicRaceVideoValidation | null> {
		const record = await this.database
			.select()
			.from(raceVideoValidation)
			.where(eq(raceVideoValidation.raceVideoId, recordingId))
			.get();
		if (!record) return null;
		const media = mediaFacts(record);
		const errorCandidate =
			record.status === 'invalid' &&
			record.errorCode !== null &&
			record.errorStage !== null &&
			record.errorMessage !== null
				? {
						code: record.errorCode,
						stage: record.errorStage,
						message: record.errorMessage,
					}
				: null;
		const parsedError =
			raceVideoValidationSafeErrorSchema.safeParse(errorCandidate);
		return {
			status: record.status === 'pending' ? 'validating' : record.status,
			stateVersion: record.stateVersion,
			media,
			error: parsedError.success ? parsedError.data : null,
			validatedAt: record.completedAt,
		};
	}

	async hasActiveAnalysis(raceVideoId: string): Promise<boolean> {
		const analysis = await this.database
			.select({ analysisId: drivingAnalysis.id })
			.from(drivingAnalysis)
			.where(
				and(
					eq(drivingAnalysis.raceVideoId, raceVideoId),
					inArray(drivingAnalysis.status, [
						'queued',
						'running',
						'awaiting-reidentification',
					]),
				),
			)
			.get();
		if (analysis) return true;
		const active = await this.database
			.select({ runId: trackingRun.id })
			.from(trackingRunInput)
			.innerJoin(trackingRun, eq(trackingRun.id, trackingRunInput.runId))
			.where(
				and(
					eq(trackingRunInput.raceVideoId, raceVideoId),
					eq(trackingRun.status, 'active'),
				),
			)
			.get();
		return Boolean(active);
	}
}
