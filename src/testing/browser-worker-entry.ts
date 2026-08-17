import { defaultAppDependencies } from '../app-dependencies';
import { DrivingAnalysisAuthority } from '../driving-analysis/analysis/driving-analysis-authority';
import { RaceRecordingAuthority } from '../driving-analysis/race-recording/race-recording-authority';
import { RaceVideoValidationAuthority } from '../driving-analysis/race-recording/race-video-validation-authority';
import {
	RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
	type RaceVideoValidationWorkflowPayload,
} from '../driving-analysis/race-recording/race-video-validation-contracts';
import { createWorker } from '../index';

const publishBrowserValidation = async (
	database: D1Database,
	payload: RaceVideoValidationWorkflowPayload,
): Promise<void> => {
	const authority = new RaceVideoValidationAuthority(database);
	const context = await authority.context(payload);
	if (context.kind !== 'pending') return;
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
				checksumSha256: 'a'.repeat(64),
			},
		},
		new Date().toISOString(),
	);
};

export default createWorker({
	...defaultAppDependencies,
	raceRecordingAuthority: (env) =>
		new RaceRecordingAuthority(env.DB, env.ANALYSIS_MEDIA, {
			startValidation: (payload) => publishBrowserValidation(env.DB, payload),
		}),
	drivingAnalysisAuthority: (env) => new DrivingAnalysisAuthority(env.DB),
});
