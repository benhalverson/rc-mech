import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { raceVideo, raceVideoValidation } from '../../schema';
import type { CreateDrivingAnalysisCommand } from '../analysis/driving-analysis-authority';
import { DrivingAnalysisAuthorityError } from '../analysis/driving-analysis-authority';
import { createDrivingAnalysisInputSchema } from '../analysis/driving-analysis-contracts';
import {
	type SourceFrameCommand,
	type SourceFrameResult,
	sourceFrameCommandSchema,
	sourceFrameResponseSchema,
} from './subject-frame-contracts';

export class SubjectFrames {
	private readonly database;
	constructor(
		binding: D1Database,
		private readonly media: (
			command: SourceFrameCommand,
		) => Promise<SourceFrameResult>,
	) {
		this.database = drizzle(binding);
	}
	private async source(ownerId: string, recordingId: string) {
		const row = await this.database
			.select({
				objectKey: raceVideo.objectKey,
				byteCount: raceVideoValidation.byteCount,
				checksumSha256: raceVideoValidation.checksumSha256,
				status: sql<string>`${raceVideo.status}`.as('status'),
				validationStatus: sql<string>`${raceVideoValidation.status}`.as(
					'validationStatus',
				),
				decodedFrameCount: raceVideoValidation.decodedFrameCount,
				durationMs: raceVideoValidation.durationMs,
			})
			.from(raceVideo)
			.innerJoin(
				raceVideoValidation,
				eq(raceVideoValidation.raceVideoId, raceVideo.id),
			)
			.where(and(eq(raceVideo.id, recordingId), eq(raceVideo.ownerId, ownerId)))
			.get();
		if (!row)
			throw new DrivingAnalysisAuthorityError(
				'NOT_FOUND',
				'Race recording not found',
			);
		if (
			row.status !== 'validating' ||
			row.validationStatus !== 'ready' ||
			row.byteCount === null ||
			row.checksumSha256 === null ||
			row.decodedFrameCount === null ||
			row.durationMs === null
		)
			throw new DrivingAnalysisAuthorityError(
				'SOURCE_UNAVAILABLE',
				'A ready source recording is required',
			);
		return {
			...row,
			byteCount: row.byteCount,
			checksumSha256: row.checksumSha256,
			decodedFrameCount: row.decodedFrameCount,
			durationMs: row.durationMs,
		};
	}
	async select(
		ownerId: string,
		recordingId: string,
		selection: SourceFrameCommand['selection'],
		includeImage: boolean,
		expectedChecksum?: string,
	) {
		const source = await this.source(ownerId, recordingId);
		if (
			(expectedChecksum !== undefined &&
				expectedChecksum !== source.checksumSha256) ||
			(selection.kind === 'frame' &&
				selection.frameIndex >= source.decodedFrameCount) ||
			(selection.kind === 'timestamp' &&
				selection.timestampMs >= source.durationMs)
		)
			throw new DrivingAnalysisAuthorityError(
				'INVALID_INPUT',
				'Select an actual frame inside the recording',
			);
		const command = sourceFrameCommandSchema.parse({
			source: {
				objectKey: source.objectKey,
				byteCount: source.byteCount,
				checksumSha256: source.checksumSha256,
			},
			selection,
			includeImage,
		});
		const frame = sourceFrameResponseSchema.parse(await this.media(command));
		if (
			frame.sourceChecksumSha256 !== source.checksumSha256 ||
			frame.frameIndex >= source.decodedFrameCount ||
			frame.timestampMs >= source.durationMs ||
			(selection.kind === 'frame' &&
				frame.frameIndex !== selection.frameIndex) ||
			(selection.kind === 'timestamp' &&
				frame.timestampMs < selection.timestampMs) ||
			includeImage !== (frame.imageBase64 !== null)
		)
			throw new DrivingAnalysisAuthorityError(
				'SOURCE_UNAVAILABLE',
				'The source frame could not be verified',
			);
		const current = await this.source(ownerId, recordingId);
		if (
			current.objectKey !== source.objectKey ||
			current.checksumSha256 !== source.checksumSha256 ||
			current.byteCount !== source.byteCount
		)
			throw new DrivingAnalysisAuthorityError(
				'SOURCE_UNAVAILABLE',
				'The source recording has changed',
			);
		return frame;
	}
	async verify(command: CreateDrivingAnalysisCommand): Promise<void> {
		const input = createDrivingAnalysisInputSchema.parse(command.input);
		const frame = await this.select(
			command.ownerId,
			input.raceVideoId,
			{ kind: 'frame', frameIndex: input.subjectSeed.frameIndex },
			false,
		);
		if (frame.timestampMs !== input.subjectSeed.timestampMs)
			throw new DrivingAnalysisAuthorityError(
				'INVALID_INPUT',
				'Subject frame and timestamp must match the verified recording frame',
			);
	}
}

export const subjectFrames = (
	environment: Pick<Env, 'DB' | 'RACE_VIDEO_MEDIA_CONTAINER'>,
) =>
	new SubjectFrames(environment.DB, (command) =>
		environment.RACE_VIDEO_MEDIA_CONTAINER.getByName(
			`subject-frame-${command.source.checksumSha256}`,
		).selectSubjectFrame(command),
	);
