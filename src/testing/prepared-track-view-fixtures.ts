import type {
	PreparedFrameManifest,
	PreparedTrackViewObject,
	PrepareStageResponse,
	TrackingRunInput,
} from '../driving-analysis/tracking/track-view-contracts';
import { RUN_ID } from './driving-analysis-tracking-fixtures';

export const RACE_VIDEO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TRACK_MAP_VERSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const PREPARED_MEDIA_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const CORRELATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const SOURCE_SHA = '7'.repeat(64);
export const MEDIA_SHA = '5'.repeat(64);
export const MANIFEST_SHA = '6'.repeat(64);
export const LAYOUT_SHA = '4'.repeat(64);

export const trackingRunInputFixture = (
	overrides: Partial<TrackingRunInput> = {},
): TrackingRunInput => ({
	contractVersion: 'tracking-run-input.v1',
	runId: RUN_ID,
	raceVideoId: RACE_VIDEO_ID,
	sourceObjectKey: `race-videos/${RACE_VIDEO_ID}/original`,
	sourceByteCount: 100,
	sourceChecksumSha256: SOURCE_SHA,
	window: { startTimestampMs: 100, endTimestampMs: 400 },
	approvedTrackMapVersionId: TRACK_MAP_VERSION_ID,
	sourceLayout: {
		version: 'fixed-track-view.v1',
		digest: LAYOUT_SHA,
		width: 320,
		height: 180,
		trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
	},
	...overrides,
});

export const preparedDescriptorFixture = (
	inputDigest: string,
	preparedMediaId = PREPARED_MEDIA_ID,
) => ({
	preparedMediaId,
	caseId: RUN_ID,
	byteCount: 14,
	checksumSha256: MEDIA_SHA,
	frameManifestByteCount: 15,
	frameManifestChecksumSha256: MANIFEST_SHA,
	sourceByteCount: 100,
	sourceChecksumSha256: SOURCE_SHA,
	window: { startTimestampMs: 100, endTimestampMs: 400 },
	trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
	width: 160,
	height: 60,
	decodedFrameCount: 3,
	averageFrameRate: { numerator: 10, denominator: 1 },
	ffmpegVersion: '7.1.2',
	pipelineVersion: 'subject-tracking.v1' as const,
	preparationInputDigest: inputDigest,
	preparationConfigurationDigest: '9'.repeat(64),
});

export const preparedObjectsFixture = (
	preparedMediaId = PREPARED_MEDIA_ID,
): [PreparedTrackViewObject, PreparedTrackViewObject] => [
	{
		role: 'prepared-media',
		objectKey: `prepared/${preparedMediaId}/track-view.mp4`,
		byteCount: 14,
		checksumSha256: MEDIA_SHA,
		contentType: 'video/mp4',
		contentEncoding: null,
	},
	{
		role: 'frame-manifest',
		objectKey: `prepared/${preparedMediaId}/frame-manifest.json.gz`,
		byteCount: 15,
		checksumSha256: MANIFEST_SHA,
		contentType: 'application/vnd.rc-mech.prepared-frame-manifest+json',
		contentEncoding: 'gzip',
	},
];

export const prepareAcceptedFixture = (
	inputDigest: string,
	preparedMediaId = PREPARED_MEDIA_ID,
	correlationId = CORRELATION_ID,
): Extract<PrepareStageResponse, { outcome: 'accepted' }> => ({
	contractVersion: 'subject-tracking.v1',
	correlationId,
	outcome: 'accepted',
	caseId: RUN_ID,
	prepared: preparedDescriptorFixture(inputDigest, preparedMediaId),
});

export const frameManifestFixture = (
	inputDigest: string,
): PreparedFrameManifest => ({
	contractVersion: 'subject-tracking.v1',
	preparedMediaId: PREPARED_MEDIA_ID,
	caseId: RUN_ID,
	sourceChecksumSha256: SOURCE_SHA,
	sourceByteCount: 100,
	window: { startTimestampMs: 100, endTimestampMs: 400 },
	trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
	mediaByteCount: 14,
	mediaChecksumSha256: MEDIA_SHA,
	width: 160,
	height: 60,
	averageFrameRate: { numerator: 10, denominator: 1 },
	ffmpegVersion: '7.1.2',
	pipelineVersion: 'subject-tracking.v1',
	preparationInputDigest: inputDigest,
	preparationConfigurationDigest: '9'.repeat(64),
	frames: [
		{ preparedFrameIndex: 0, frameIndex: 2, timestampMs: 100 },
		{ preparedFrameIndex: 1, frameIndex: 4, timestampMs: 215 },
		{ preparedFrameIndex: 2, frameIndex: 7, timestampMs: 333 },
	],
});
