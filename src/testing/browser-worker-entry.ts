import { DurableObject } from 'cloudflare:workers';
import { defaultAppDependencies } from '../app-dependencies';
import { DrivingAnalysisAuthority } from '../driving-analysis/analysis/driving-analysis-authority';
import { RaceRecordingAuthority } from '../driving-analysis/race-recording/race-recording-authority';
import type { ReferenceFrameExtractionCommand } from '../driving-analysis/race-recording/race-video-media-container';
import { RaceVideoValidationAuthority } from '../driving-analysis/race-recording/race-video-validation-authority';
import {
	RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
	type RaceVideoValidationWorkflowPayload,
} from '../driving-analysis/race-recording/race-video-validation-contracts';
import { createWorker } from '../index';

const browserReferenceFrame = Uint8Array.from(
	atob(
		'/9j/4AAQSkZJRgABAgAAAQABAAD//gARTGF2YzU4LjEzNC4xMDAA/9sAQwAIBAQEBAQFBQUFBQUGBgYGBgYGBgYGBgYGBwcHCAgIBwcHBgYHBwgICAgJCQkICAgICQkKCgoMDAsLDg4OEREU/8QASwABAQAAAAAAAAAAAAAAAAAAAAgBAQAAAAAAAAAAAAAAAAAAAAAQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAIABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCfwAf/2Q==',
	),
	(character) => character.charCodeAt(0),
);

export class BrowserRaceVideoMediaContainer extends DurableObject<
	Pick<Env, 'ANALYSIS_MEDIA'>
> {
	async extractReferenceFrame(command: ReferenceFrameExtractionCommand) {
		const checksumSha256 = [
			...new Uint8Array(
				await crypto.subtle.digest('SHA-256', browserReferenceFrame),
			),
		]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
		await this.env.ANALYSIS_MEDIA.put(
			command.outputObjectKey,
			browserReferenceFrame,
			{
				httpMetadata: { contentType: 'image/jpeg' },
				customMetadata: { sha256: checksumSha256 },
			},
		);
		return {
			objectKey: command.outputObjectKey,
			byteCount: browserReferenceFrame.byteLength,
			checksumSha256,
			contentType: 'image/jpeg' as const,
		};
	}
}

const publishBrowserValidation = async (
	database: D1Database,
	media: R2Bucket,
	payload: RaceVideoValidationWorkflowPayload,
): Promise<void> => {
	const authority = new RaceVideoValidationAuthority(database);
	const context = await authority.context(payload);
	if (context.kind !== 'pending') return;
	const source = await media.get(context.objectKey);
	if (!source) throw new Error('Browser Race recording is missing');
	const checksumSha256 = [
		...new Uint8Array(
			await crypto.subtle.digest('SHA-256', await source.arrayBuffer()),
		),
	]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	await authority.publish(
		payload,
		{
			contractVersion: RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
			correlationId: context.validationId,
			outcome: 'accepted',
			media: {
				byteCount: context.expectedByteCount,
				durationMs: 1_000,
				width: 160,
				height: 90,
				videoCodec: 'h264',
				audioCodecs: [],
				containerFormats: ['mp4'],
				decodedFrameCount: 10,
				averageFrameRate: { numerator: 10, denominator: 1 },
				timeBase: { numerator: 1, denominator: 10_240 },
				sampleAspectRatio: { numerator: 1, denominator: 1 },
				displayAspectRatio: { numerator: 16, denominator: 9 },
				startTimeMs: 0,
				checksumSha256,
			},
		},
		new Date().toISOString(),
	);
};

export default createWorker({
	...defaultAppDependencies,
	raceRecordingAuthority: (env) =>
		new RaceRecordingAuthority(env.DB, env.ANALYSIS_MEDIA, {
			startValidation: (payload) =>
				publishBrowserValidation(env.DB, env.ANALYSIS_MEDIA, payload),
		}),
	drivingAnalysisAuthority: (env) => new DrivingAnalysisAuthority(env.DB),
});
