import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	authRateLimit,
	car,
	driveSession,
	drivingAnalysis,
	owner,
	raceVideo,
	raceVideoValidation,
	trackCorner,
	trackLayout,
	trackMapReferenceFrame,
	trackMapVersion,
} from '../../schema';
import { inferenceProfileFixture } from '../../testing/driving-analysis-tracking-fixtures';
import { MockR2Controller } from '../../testing/hono-fixture';
import { createSqliteD1, type SqliteD1Fixture } from '../../testing/sqlite-d1';
import { RaceRecordingAuthority } from '../race-recording/race-recording-authority';
import { RaceVideoValidationAuthority } from '../race-recording/race-video-validation-authority';
import {
	inferenceProfileAuthority,
	trackingRun,
} from '../tracking/authority-schema';
import {
	DrivingAnalysisAuthority,
	DrivingAnalysisAuthorityError,
} from './driving-analysis-authority';

const OWNER_ID = 'owner-1';
const CAR_ID = '11111111-1111-4111-8111-111111111111';
const DRIVE_ID = '22222222-2222-4222-8222-222222222222';
const RACE_VIDEO_ID = '33333333-3333-4333-8333-333333333333';
const MAP_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const ANALYSIS_ID = '66666666-6666-4666-8666-666666666666';
const RETRY_WORKFLOW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-08-17T18:00:00.000Z');

const migrationDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../migrations',
);
const drivingAnalysisMigration = readFileSync(
	resolve(migrationDirectory, '0026_driving_analysis_creation.sql'),
	'utf8',
);
const migrations = readdirSync(migrationDirectory)
	.filter((name) => /^\d+.*\.sql$/.test(name))
	.sort()
	.map((name) => readFileSync(resolve(migrationDirectory, name), 'utf8'))
	.join('\n');

let sqlite: SqliteD1Fixture | undefined;

afterEach(() => {
	sqlite?.close();
	sqlite = undefined;
	vi.restoreAllMocks();
});

const seedReadyInput = async (database: D1Database) => {
	const orm = drizzle(database);
	const timestamp = NOW.toISOString();
	await orm.insert(owner).values({
		id: OWNER_ID,
		name: 'Owner',
		email: 'owner@example.com',
		emailVerified: true,
		createdAt: NOW,
		updatedAt: NOW,
		timezone: 'UTC',
	});
	await orm.insert(car).values({
		id: CAR_ID,
		ownerId: OWNER_ID,
		name: 'Buggy',
		createdAt: timestamp,
	});
	await orm.insert(driveSession).values({
		id: DRIVE_ID,
		carId: CAR_ID,
		startedAt: timestamp,
	});
	await orm.insert(raceVideo).values({
		id: RACE_VIDEO_ID,
		ownerId: OWNER_ID,
		carId: CAR_ID,
		driveSessionId: DRIVE_ID,
		requestId: '77777777-7777-4777-8777-777777777777',
		objectKey: `race-recordings/private/${RACE_VIDEO_ID}`,
		multipartUploadId: 'upload-1',
		fileName: 'Main race.mov',
		contentType: 'video/quicktime',
		declaredSize: 1024,
		actualSize: 1024,
		partSize: 10 * 1024 * 1024,
		status: 'validating',
		createdAt: timestamp,
		updatedAt: timestamp,
		expiresAt: new Date('2026-08-18T18:00:00.000Z').toISOString(),
		completedAt: timestamp,
	});
	await orm.insert(raceVideoValidation).values({
		raceVideoId: RACE_VIDEO_ID,
		validationId: '88888888-8888-4888-8888-888888888888',
		status: 'ready',
		stateVersion: 2,
		byteCount: 1024,
		durationMs: 1_200_000,
		width: 1920,
		height: 1080,
		videoCodec: 'h264',
		audioCodecsJson: '[]',
		containerFormatsJson: '["mov"]',
		decodedFrameCount: 36_000,
		averageFrameRateNumerator: 30,
		averageFrameRateDenominator: 1,
		timeBaseNumerator: 1,
		timeBaseDenominator: 90_000,
		sampleAspectRatioNumerator: 1,
		sampleAspectRatioDenominator: 1,
		displayAspectRatioNumerator: 16,
		displayAspectRatioDenominator: 9,
		startTimeMs: 0,
		checksumSha256: 'a'.repeat(64),
		startedAt: timestamp,
		updatedAt: timestamp,
		completedAt: timestamp,
	});
	await orm.insert(trackLayout).values({
		id: '99999999-9999-4999-8999-999999999999',
		name: 'Indoor clay',
		status: 'active',
		createdBy: OWNER_ID,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	await orm.insert(trackMapVersion).values({
		id: MAP_VERSION_ID,
		layoutId: '99999999-9999-4999-8999-999999999999',
		version: 1,
		stateVersion: 1,
		status: 'draft',
		createdBy: OWNER_ID,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	await orm.insert(trackCorner).values({
		id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		mapVersionId: MAP_VERSION_ID,
		key: 'turn-one',
		name: 'Turn one',
		order: 1,
		entryStartX: 0.1,
		entryStartY: 0.1,
		entryEndX: 0.2,
		entryEndY: 0.2,
		entryDirection: 'forward',
		exitStartX: 0.3,
		exitStartY: 0.3,
		exitEndX: 0.4,
		exitEndY: 0.4,
		exitDirection: 'forward',
		viewX: 0,
		viewY: 0,
		viewWidth: 1,
		viewHeight: 1,
	});
	await orm.insert(trackMapReferenceFrame).values({
		id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
		mapVersionId: MAP_VERSION_ID,
		raceVideoId: RACE_VIDEO_ID,
		timestampMs: 1000,
		objectKey: `track-map-reference-frames/${MAP_VERSION_ID}/frame.jpg`,
		byteCount: 3,
		checksumSha256: 'a'.repeat(64),
		contentType: 'image/jpeg',
		createdBy: OWNER_ID,
		createdAt: timestamp,
	});
	await orm
		.update(trackMapVersion)
		.set({
			status: 'approved',
			stateVersion: 2,
			approvedBy: OWNER_ID,
			approvedAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
};

const input = () => ({
	requestId: REQUEST_ID,
	raceVideoId: RACE_VIDEO_ID,
	approvedTrackMapVersionId: MAP_VERSION_ID,
	raceWindow: { startTimestampMs: 120_000, endTimestampMs: 720_000 },
	subjectSeed: {
		timestampMs: 180_000,
		frameIndex: 1800,
		identity: 'subject-1',
		box: { x: 0.25, y: 0.4, width: 0.08, height: 0.06 },
	},
});

const command = () => ({
	ownerId: OWNER_ID,
	carId: CAR_ID,
	driveSessionId: DRIVE_ID,
	input: input(),
});

const fixture = async () => {
	sqlite = createSqliteD1();
	sqlite.exec(migrations);
	await seedReadyInput(sqlite.database);
	const startProcessing = vi.fn(async () => undefined);
	const authority = new DrivingAnalysisAuthority(sqlite.database, {
		clock: () => NOW,
		id: () => ANALYSIS_ID,
		workflowId: () => RETRY_WORKFLOW_ID,
		startProcessing,
	});
	return { authority, startProcessing, database: drizzle(sqlite.database) };
};

const expectCode = async (
	promise: Promise<unknown>,
	code: DrivingAnalysisAuthorityError['code'],
) => {
	await expect(promise).rejects.toMatchObject({
		name: 'DrivingAnalysisAuthorityError',
		code,
	});
};

describe('DrivingAnalysisAuthority', () => {
	test('returns only the owner-scoped validated recording source facts', async () => {
		const value = await fixture();
		await value.authority.create(command());
		await expect(
			value.authority.preparationSource(OWNER_ID, ANALYSIS_ID),
		).resolves.toEqual({
			objectKey: `race-recordings/private/${RACE_VIDEO_ID}`,
			byteCount: 1024,
			checksumSha256: 'a'.repeat(64),
		});
		await expect(
			value.authority.preparationSource('user-1', ANALYSIS_ID),
		).rejects.toMatchObject({ code: 'CONFLICT' });
	});

	test('keeps lifecycle triggers compatible with the remote D1 migration parser', () => {
		const lifecycleTrigger = drivingAnalysisMigration.split(
			'CREATE TRIGGER driving_analysis_lifecycle_transition',
		)[1];
		expect(lifecycleTrigger).toBeDefined();
		expect(lifecycleTrigger).not.toContain('CASE');
	});

	test('pins immutable creation inputs and replays one client request identity', async () => {
		const { authority, startProcessing } = await fixture();
		const created = await authority.create(command());
		expect(created).toMatchObject({
			created: true,
			analysis: {
				id: ANALYSIS_ID,
				requestId: REQUEST_ID,
				carId: CAR_ID,
				driveSessionId: DRIVE_ID,
				raceVideoId: RACE_VIDEO_ID,
				raceWindow: input().raceWindow,
				approvedTrackMapVersionId: MAP_VERSION_ID,
				subjectSeed: input().subjectSeed,
				sourceLayout: {
					version: 'fixed-track-view.v1',
					width: 1920,
					height: 1080,
					trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
				},
				status: 'queued',
				stage: 'preparation',
				progress: 0,
				stateVersion: 1,
				createdAt: NOW.toISOString(),
				updatedAt: NOW.toISOString(),
			},
		});
		expect(created.analysis.sourceLayout.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(startProcessing).toHaveBeenCalledWith({
			kind: 'analysis-creation.v1',
			ownerId: OWNER_ID,
			analysisId: ANALYSIS_ID,
			workflowId: ANALYSIS_ID,
			expectedStateVersion: 1,
		});

		await expect(authority.create(command())).resolves.toEqual({
			analysis: created.analysis,
			created: false,
		});
		expect(startProcessing).toHaveBeenCalledTimes(2);

		await expectCode(
			authority.create({
				...command(),
				input: {
					...input(),
					subjectSeed: {
						...input().subjectSeed,
						box: { ...input().subjectSeed.box, x: 0.3 },
					},
				},
			}),
			'CONFLICT',
		);
	});

	test('returns the winning immutable analysis when identical requests race', async () => {
		const { authority } = await fixture();
		if (!sqlite) throw new Error('SQLite fixture unavailable');
		const peer = new DrivingAnalysisAuthority(sqlite.database, {
			clock: () => NOW,
			id: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			startProcessing: async () => undefined,
		});
		const results = await Promise.all([
			authority.create(command()),
			peer.create(command()),
		]);
		expect(results.map(({ created }) => created).sort()).toEqual([false, true]);
		expect(results[0]?.analysis).toEqual(results[1]?.analysis);
	});

	test('publishes lifecycle progress through fenced monotonic D1 transitions', async () => {
		const { authority } = await fixture();
		await authority.create(command());
		const payload = {
			kind: 'analysis-creation.v1' as const,
			ownerId: OWNER_ID,
			analysisId: ANALYSIS_ID,
			workflowId: ANALYSIS_ID,
			expectedStateVersion: 1,
		};
		await expectCode(
			authority.beginPreparation(
				payload,
				ANALYSIS_ID,
				null as unknown as string,
			),
			'CONFLICT',
		);
		await expect(
			authority.beginPreparation(
				payload,
				ANALYSIS_ID,
				new Date('2026-08-17T18:00:01.000Z').toISOString(),
			),
		).resolves.toMatchObject({
			kind: 'published',
			analysis: {
				status: 'running',
				stage: 'preparation',
				progress: 0,
				stateVersion: 2,
			},
		});
		await expect(
			authority.publishPreparationProgress(
				{ ...payload, expectedStateVersion: 2 },
				ANALYSIS_ID,
				15,
				new Date('2026-08-17T18:00:02.000Z').toISOString(),
			),
		).resolves.toMatchObject({
			kind: 'published',
			analysis: { progress: 15, stateVersion: 3 },
		});
		await expect(
			authority.publishPreparationProgress(
				{ ...payload, expectedStateVersion: 2 },
				ANALYSIS_ID,
				15,
				new Date('2026-08-17T18:00:02.000Z').toISOString(),
			),
		).resolves.toMatchObject({
			kind: 'replayed',
			analysis: { progress: 15, stateVersion: 3 },
		});
		await expectCode(
			authority.publishPreparationProgress(
				{ ...payload, expectedStateVersion: 3 },
				ANALYSIS_ID,
				10,
				new Date('2026-08-17T18:00:03.000Z').toISOString(),
			),
			'CONFLICT',
		);
		await expect(authority.get(OWNER_ID, ANALYSIS_ID)).resolves.toMatchObject({
			progress: 15,
			stateVersion: 3,
		});
		await expect(
			authority.beginPreparation(
				payload,
				ANALYSIS_ID,
				new Date('2026-08-17T18:00:04.000Z').toISOString(),
			),
		).resolves.toMatchObject({ kind: 'replayed' });
		await expect(
			authority.beginPreparation(
				{ ...payload, expectedStateVersion: 3 },
				ANALYSIS_ID,
				new Date('2026-08-17T18:00:04.000Z').toISOString(),
			),
		).resolves.toEqual({ kind: 'stale' });
		await expect(
			authority.publishPreparationProgress(
				{ ...payload, expectedStateVersion: 2 },
				'77777777-7777-4777-8777-777777777777',
				15,
				new Date('2026-08-17T18:00:04.000Z').toISOString(),
			),
		).resolves.toEqual({ kind: 'stale' });
		await expect(
			authority.publishPreparationProgress(
				{ ...payload, expectedStateVersion: 2 },
				ANALYSIS_ID,
				20,
				new Date('2026-08-17T18:00:04.000Z').toISOString(),
			),
		).resolves.toEqual({ kind: 'stale' });
		await expect(
			authority.beginPreparation(
				{ ...payload, ownerId: 'another-owner' },
				ANALYSIS_ID,
				new Date('2026-08-17T18:00:04.000Z').toISOString(),
			),
		).resolves.toEqual({ kind: 'stale' });
		await expect(
			authority.beginPreparation(
				payload,
				'77777777-7777-4777-8777-777777777777',
				new Date('2026-08-17T18:00:04.000Z').toISOString(),
			),
		).resolves.toEqual({ kind: 'stale' });
		for (const progress of [0, 100, 1.5])
			await expectCode(
				authority.publishPreparationProgress(
					{ ...payload, expectedStateVersion: 3 },
					ANALYSIS_ID,
					progress,
					new Date('2026-08-17T18:00:04.000Z').toISOString(),
				),
				'INVALID_INPUT',
			);
		await expectCode(
			authority.publishPreparationProgress(
				{ ...payload, expectedStateVersion: 3 },
				ANALYSIS_ID,
				20,
				null as unknown as string,
			),
			'CONFLICT',
		);
	});

	test('publishes the transition from preparation into tracking', async () => {
		const { authority, database } = await fixture();
		await authority.create(command());
		const payload = {
			kind: 'analysis-creation.v1' as const,
			ownerId: OWNER_ID,
			analysisId: ANALYSIS_ID,
			workflowId: ANALYSIS_ID,
			expectedStateVersion: 1,
		};
		await authority.beginPreparation(
			payload,
			ANALYSIS_ID,
			new Date('2026-08-17T18:00:01.000Z').toISOString(),
		);
		await authority.publishPreparationProgress(
			{ ...payload, expectedStateVersion: 2 },
			ANALYSIS_ID,
			20,
			new Date('2026-08-17T18:00:02.000Z').toISOString(),
		);
		await expect(
			authority.publishTrackingStart(
				{ ...payload, expectedStateVersion: 3 },
				ANALYSIS_ID,
				3,
				new Date('2026-08-17T18:00:03.000Z').toISOString(),
			),
		).resolves.toMatchObject({
			kind: 'published',
			analysis: { stage: 'tracking', progress: 21, stateVersion: 4 },
		});
		await expect(
			authority.publishTrackingStart(
				{ ...payload, expectedStateVersion: 3 },
				ANALYSIS_ID,
				3,
				new Date('2026-08-17T18:00:03.000Z').toISOString(),
			),
		).resolves.toMatchObject({ kind: 'replayed' });
		await expect(
			authority.publishTrackingStart(
				{ ...payload, expectedStateVersion: 3 },
				'77777777-7777-4777-8777-777777777777',
				3,
				new Date('2026-08-17T18:00:04.000Z').toISOString(),
			),
		).resolves.toEqual({ kind: 'stale' });
		await expect(
			authority.publishTrackingState(
				OWNER_ID,
				ANALYSIS_ID,
				{
					runId: '99999999-9999-4999-8999-999999999999',
					lifecycle: 'running',
					stage: 'tracking',
					progress: 99,
					waitReason: null,
					safeFailureCode: null,
				},
				new Date('2026-08-17T18:00:04.000Z').toISOString(),
			),
		).resolves.toEqual({ kind: 'stale' });

		const profile = inferenceProfileFixture();
		await database.insert(inferenceProfileAuthority).values({
			profileDigest:
				'5abae405db4372b704fe5c0984d1d8a2ed02363a52fbeac5ea09b0f7ec7a6b58',
			contractVersion: profile.contractVersion,
			canonicalizationVersion: profile.canonicalizationVersion,
			configurationJson: JSON.stringify(profile),
			createdAt: NOW.toISOString(),
		});
		await database.insert(trackingRun).values({
			id: '99999999-9999-4999-8999-999999999999',
			analysisId: ANALYSIS_ID,
			ownerId: OWNER_ID,
			sequence: 1,
			workflowId: ANALYSIS_ID,
			profileDigest:
				'5abae405db4372b704fe5c0984d1d8a2ed02363a52fbeac5ea09b0f7ec7a6b58',
			inputDigest: 'b'.repeat(64),
			status: 'active',
			version: 1,
			createdAt: NOW.toISOString(),
			completedAt: null,
		});
		const trackingState = {
			runId: '99999999-9999-4999-8999-999999999999',
			lifecycle: 'running' as const,
			stage: 'tracking' as const,
			progress: 99,
			waitReason: null,
			safeFailureCode: null,
		};
		await expect(
			authority.publishTrackingState(
				OWNER_ID,
				ANALYSIS_ID,
				trackingState,
				new Date('2026-08-17T18:00:05.000Z').toISOString(),
			),
		).resolves.toMatchObject({
			kind: 'published',
			analysis: {
				lifecycle: 'tracking-complete',
				status: 'running',
				stage: 'tracking',
				progress: 99,
			},
		});
		await expect(
			authority.publishTrackingState(
				OWNER_ID,
				ANALYSIS_ID,
				trackingState,
				new Date('2026-08-17T18:00:05.000Z').toISOString(),
			),
		).resolves.toMatchObject({ kind: 'replayed' });
		await expect(
			authority.publishTrackingState(
				OWNER_ID,
				ANALYSIS_ID,
				{ ...trackingState, lifecycle: 'completed', progress: 100 },
				new Date('2026-08-17T18:00:05.000Z').toISOString(),
			),
		).resolves.toMatchObject({ kind: 'replayed' });
		await expect(
			authority.publishTrackingState(
				OWNER_ID,
				ANALYSIS_ID,
				{
					...trackingState,
					lifecycle: 'awaiting-reidentification',
				},
				new Date('2026-08-17T18:00:06.000Z').toISOString(),
			),
		).resolves.toMatchObject({
			kind: 'published',
			analysis: { lifecycle: 'awaiting-reidentification' },
		});
		await expect(
			authority.publishTrackingState(
				OWNER_ID,
				ANALYSIS_ID,
				{ ...trackingState, lifecycle: 'cancelled', progress: 75 },
				new Date('2026-08-17T18:00:07.000Z').toISOString(),
			),
		).resolves.toMatchObject({
			kind: 'published',
			analysis: { lifecycle: 'cancelled', progress: 99 },
		});
	});

	test('publishes a safe Tracking failure without completing the analysis', async () => {
		const { authority, database } = await fixture();
		await authority.create(command());
		const payload = {
			kind: 'analysis-creation.v1' as const,
			ownerId: OWNER_ID,
			analysisId: ANALYSIS_ID,
			workflowId: ANALYSIS_ID,
			expectedStateVersion: 1,
		};
		await authority.beginPreparation(
			payload,
			ANALYSIS_ID,
			new Date('2026-08-17T18:00:01.000Z').toISOString(),
		);
		await authority.publishPreparationProgress(
			{ ...payload, expectedStateVersion: 2 },
			ANALYSIS_ID,
			20,
			new Date('2026-08-17T18:00:02.000Z').toISOString(),
		);
		await authority.publishTrackingStart(
			{ ...payload, expectedStateVersion: 3 },
			ANALYSIS_ID,
			3,
			new Date('2026-08-17T18:00:03.000Z').toISOString(),
		);
		const profile = inferenceProfileFixture();
		const profileDigest =
			'5abae405db4372b704fe5c0984d1d8a2ed02363a52fbeac5ea09b0f7ec7a6b58';
		await database.insert(inferenceProfileAuthority).values({
			profileDigest,
			contractVersion: profile.contractVersion,
			canonicalizationVersion: profile.canonicalizationVersion,
			configurationJson: JSON.stringify(profile),
			createdAt: NOW.toISOString(),
		});
		await database.insert(trackingRun).values({
			id: '99999999-9999-4999-8999-999999999999',
			analysisId: ANALYSIS_ID,
			ownerId: OWNER_ID,
			sequence: 1,
			workflowId: ANALYSIS_ID,
			profileDigest,
			inputDigest: 'b'.repeat(64),
			status: 'active',
			version: 1,
			createdAt: NOW.toISOString(),
			completedAt: null,
		});
		await expect(
			authority.publishTrackingState(
				OWNER_ID,
				ANALYSIS_ID,
				{
					runId: '99999999-9999-4999-8999-999999999999',
					lifecycle: 'running',
					stage: 'tracking',
					progress: 50,
					waitReason: null,
					safeFailureCode: null,
				},
				new Date('2026-08-17T18:00:04.000Z').toISOString(),
			),
		).resolves.toMatchObject({
			kind: 'published',
			analysis: { lifecycle: 'tracking', progress: 50 },
		});
		await expect(
			authority.publishTrackingState(
				OWNER_ID,
				ANALYSIS_ID,
				{
					runId: '99999999-9999-4999-8999-999999999999',
					lifecycle: 'failed',
					stage: 'tracking',
					progress: 75,
					waitReason: null,
					safeFailureCode: 'TRACKING_PROVIDER_FAILED',
				},
				new Date('2026-08-17T18:00:04.000Z').toISOString(),
			),
		).resolves.toMatchObject({
			kind: 'published',
			analysis: { lifecycle: 'failed', status: 'failed', progress: 75 },
		});
		await expect(
			authority.publishTrackingState(
				OWNER_ID,
				ANALYSIS_ID,
				{
					runId: '99999999-9999-4999-8999-999999999999',
					lifecycle: 'running',
					stage: 'tracking',
					progress: 90,
					waitReason: null,
					safeFailureCode: null,
				},
				new Date('2026-08-17T18:00:05.000Z').toISOString(),
			),
		).resolves.toEqual({ kind: 'stale' });
	});

	test('retries with fresh Workflow authority while preserving immutable input', async () => {
		const { authority, database, startProcessing } = await fixture();
		await authority.create(command());
		await expectCode(authority.retry(OWNER_ID, ANALYSIS_ID, 1), 'CONFLICT');
		const payload = {
			kind: 'analysis-creation.v1' as const,
			ownerId: OWNER_ID,
			analysisId: ANALYSIS_ID,
			workflowId: ANALYSIS_ID,
			expectedStateVersion: 1,
		};
		await authority.beginPreparation(
			payload,
			ANALYSIS_ID,
			new Date('2026-08-17T18:00:01.000Z').toISOString(),
		);
		await authority.publishPreparationProgress(
			{ ...payload, expectedStateVersion: 2 },
			ANALYSIS_ID,
			20,
			new Date('2026-08-17T18:00:02.000Z').toISOString(),
		);
		await authority.publishTrackingStart(
			{ ...payload, expectedStateVersion: 3 },
			ANALYSIS_ID,
			3,
			new Date('2026-08-17T18:00:03.000Z').toISOString(),
		);
		const before = await authority.get(OWNER_ID, ANALYSIS_ID);
		const profile = inferenceProfileFixture();
		const profileDigest =
			'5abae405db4372b704fe5c0984d1d8a2ed02363a52fbeac5ea09b0f7ec7a6b58';
		await database.insert(inferenceProfileAuthority).values({
			profileDigest,
			contractVersion: profile.contractVersion,
			canonicalizationVersion: profile.canonicalizationVersion,
			configurationJson: JSON.stringify(profile),
			createdAt: NOW.toISOString(),
		});
		await database.insert(trackingRun).values({
			id: '99999999-9999-4999-8999-999999999999',
			analysisId: ANALYSIS_ID,
			ownerId: OWNER_ID,
			sequence: 1,
			workflowId: ANALYSIS_ID,
			profileDigest,
			inputDigest: 'b'.repeat(64),
			status: 'active',
			version: 1,
			createdAt: NOW.toISOString(),
			completedAt: null,
		});

		await expect(
			authority.retry(OWNER_ID, ANALYSIS_ID, 4),
		).resolves.toMatchObject({
			retried: true,
			analysis: {
				id: before.id,
				requestId: before.requestId,
				raceVideoId: before.raceVideoId,
				raceWindow: before.raceWindow,
				subjectSeed: before.subjectSeed,
				approvedTrackMapVersionId: before.approvedTrackMapVersionId,
				lifecycle: 'preparation',
				status: 'queued',
				stage: 'preparation',
				progress: 0,
				stateVersion: 5,
			},
		});
		const persisted = await database
			.select()
			.from(drivingAnalysis)
			.where(eq(drivingAnalysis.id, ANALYSIS_ID))
			.get();
		expect(persisted).toMatchObject({
			workflowId: RETRY_WORKFLOW_ID,
			workflowSequence: 2,
			requestId: before.requestId,
		});
		expect(
			await database
				.select()
				.from(trackingRun)
				.where(eq(trackingRun.id, '99999999-9999-4999-8999-999999999999'))
				.get(),
		).toMatchObject({ status: 'replaced', version: 2 });
		expect(startProcessing).toHaveBeenLastCalledWith({
			kind: 'analysis-creation.v1',
			ownerId: OWNER_ID,
			analysisId: ANALYSIS_ID,
			workflowId: RETRY_WORKFLOW_ID,
			expectedStateVersion: 5,
		});
		await expect(
			authority.beginPreparation(
				payload,
				ANALYSIS_ID,
				new Date('2026-08-17T18:00:04.000Z').toISOString(),
			),
		).resolves.toEqual({ kind: 'stale' });
		await expect(
			authority.retry(OWNER_ID, ANALYSIS_ID, 5),
		).resolves.toMatchObject({ retried: false, analysis: { stateVersion: 5 } });
		await expectCode(
			authority.retry(OWNER_ID, ANALYSIS_ID, 0),
			'INVALID_INPUT',
		);
		await expectCode(authority.retry('user-1', ANALYSIS_ID, 5), 'NOT_FOUND');
		await expectCode(authority.retry(OWNER_ID, ANALYSIS_ID, 4), 'CONFLICT');
	});

	test('enforces active-analysis quota and the atomic D1 quota trigger', async () => {
		const { authority, database } = await fixture();
		await authority.create(command());
		const persisted = await database.select().from(drivingAnalysis).get();
		if (!persisted) throw new Error('Driving-analysis fixture was not created');
		for (const suffix of ['1', '2'])
			await database.insert(drivingAnalysis).values({
				...persisted,
				id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${suffix}`,
				requestId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${suffix}`,
				workflowId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${suffix}`,
			});
		await expectCode(
			authority.create({
				...command(),
				input: {
					...input(),
					requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
				},
			}),
			'QUOTA_EXCEEDED',
		);
		await expect(
			database.insert(drivingAnalysis).values({
				...persisted,
				id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
				requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
				workflowId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
			}),
		).rejects.toThrow('Failed query');
	});

	test('rate-limits new commands while exact replays remain available', async () => {
		const { authority, database } = await fixture();
		await database.insert(authRateLimit).values({
			key: `driving-analysis:${OWNER_ID}`,
			windowStartedAt: NOW.getTime(),
			count: 20,
		});
		await expectCode(authority.create(command()), 'RATE_LIMITED');
		await database
			.update(authRateLimit)
			.set({ windowStartedAt: NOW.getTime() - 3_600_001 })
			.run();
		const created = await authority.create(command());
		await expect(authority.create(command())).resolves.toEqual({
			analysis: created.analysis,
			created: false,
		});
	});

	test('fails closed when the rate-limit permit cannot be persisted', async () => {
		const { authority } = await fixture();
		if (!sqlite) throw new Error('SQLite fixture unavailable');
		sqlite.exec(`
			CREATE TRIGGER ignore_driving_analysis_permit
			BEFORE INSERT ON auth_rate_limit
			WHEN NEW.key = 'driving-analysis:${OWNER_ID}'
			BEGIN SELECT RAISE(IGNORE); END;
		`);
		await expectCode(authority.create(command()), 'RATE_LIMITED');
	});

	test('returns stale when authority disappears during a fenced transition', async () => {
		const { authority } = await fixture();
		await authority.create(command());
		if (!sqlite) throw new Error('SQLite fixture unavailable');
		sqlite.exec(`
			CREATE TRIGGER remove_driving_analysis_during_transition
			BEFORE UPDATE ON driving_analysis
			BEGIN
				DELETE FROM driving_analysis WHERE id = OLD.id;
				SELECT RAISE(IGNORE);
			END;
		`);
		await expect(
			authority.beginPreparation(
				{
					kind: 'analysis-creation.v1',
					ownerId: OWNER_ID,
					analysisId: ANALYSIS_ID,
					workflowId: ANALYSIS_ID,
					expectedStateVersion: 1,
				},
				ANALYSIS_ID,
				'2026-08-17T18:00:01.000Z',
			),
		).resolves.toEqual({ kind: 'stale' });
	});

	test('blocks source deletion while active and permits it after completion', async () => {
		const { authority, database } = await fixture();
		await authority.create(command());
		if (!sqlite) throw new Error('SQLite fixture unavailable');
		const validation = new RaceVideoValidationAuthority(sqlite.database);
		const r2 = new MockR2Controller();
		const recording = await database
			.select({ objectKey: raceVideo.objectKey })
			.from(raceVideo)
			.get();
		if (!recording) throw new Error('Race recording fixture unavailable');
		r2.seed(recording.objectKey, new Uint8Array([1, 2, 3]));
		const recordings = new RaceRecordingAuthority(sqlite.database, r2.bucket);
		expect(await validation.hasActiveAnalysis(RACE_VIDEO_ID)).toBe(true);
		await expect(
			recordings.remove({ ownerId: OWNER_ID, recordingId: RACE_VIDEO_ID }),
		).rejects.toMatchObject({ code: 'CONFLICT' });
		expect(r2.objects.size).toBe(1);
		await authority.beginPreparation(
			{
				kind: 'analysis-creation.v1',
				ownerId: OWNER_ID,
				analysisId: ANALYSIS_ID,
				workflowId: ANALYSIS_ID,
				expectedStateVersion: 1,
			},
			ANALYSIS_ID,
			new Date('2026-08-17T18:00:01.000Z').toISOString(),
		);
		await database
			.update(drivingAnalysis)
			.set({
				status: 'completed',
				stage: 'finalization',
				progress: 100,
				stateVersion: 3,
				updatedAt: '2026-08-17T18:00:02.000Z',
			})
			.run();
		expect(await validation.hasActiveAnalysis(RACE_VIDEO_ID)).toBe(false);
		await recordings.remove({ ownerId: OWNER_ID, recordingId: RACE_VIDEO_ID });
		expect(r2.objects.size).toBe(0);
		expect(await database.select().from(raceVideo)).toEqual([]);
	});

	test('rejects invalid, unavailable, and cross-owner immutable inputs', async () => {
		const { authority, database } = await fixture();
		await expectCode(
			authority.create({ ...command(), input: {} }),
			'INVALID_INPUT',
		);
		await expectCode(
			authority.create({
				...command(),
				input: {
					...input(),
					raceWindow: { startTimestampMs: 0, endTimestampMs: 900_001 },
				},
			}),
			'INVALID_INPUT',
		);
		await expectCode(
			authority.create({
				...command(),
				input: {
					...input(),
					raceWindow: { startTimestampMs: 900_000, endTimestampMs: 1_200_001 },
					subjectSeed: { ...input().subjectSeed, timestampMs: 900_000 },
				},
			}),
			'INVALID_INPUT',
		);
		await expectCode(
			authority.create({ ...command(), carId: 'missing-car' }),
			'NOT_FOUND',
		);
		await expectCode(
			authority.create({
				...command(),
				input: {
					...input(),
					raceVideoId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
				},
			}),
			'NOT_FOUND',
		);
		await database.delete(raceVideoValidation).run();
		await expectCode(authority.create(command()), 'CONFLICT');
		await seedReadyInputAfterValidationDeletion(database);
		await database
			.update(trackLayout)
			.set({
				status: 'retired',
				retiredAt: NOW.toISOString(),
				updatedAt: NOW.toISOString(),
			})
			.run();
		await expectCode(authority.create(command()), 'CONFLICT');
		await expectCode(authority.get('another-owner', ANALYSIS_ID), 'NOT_FOUND');
	});

	test('uses defaults, surfaces Workflow outage, and rejects generated identity collision', async () => {
		const { authority } = await fixture();
		await authority.create(command());
		await expectCode(
			authority.create({
				...command(),
				input: {
					...input(),
					requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
				},
			}),
			'CONFLICT',
		);
		if (!sqlite) throw new Error('SQLite fixture unavailable');
		const unavailable = new DrivingAnalysisAuthority(sqlite.database, {
			id: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
			startProcessing: async () => {
				throw new Error('workflow down');
			},
		});
		await expectCode(
			unavailable.create({
				...command(),
				input: {
					...input(),
					requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
				},
			}),
			'WORKFLOW_UNAVAILABLE',
		);
		const defaults = new DrivingAnalysisAuthority(sqlite.database);
		const created = await defaults.create({
			...command(),
			input: {
				...input(),
				requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
			},
		});
		expect(created.analysis.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(created.analysis.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

const seedReadyInputAfterValidationDeletion = async (
	database: ReturnType<typeof drizzle>,
) => {
	const timestamp = NOW.toISOString();
	await database.insert(raceVideoValidation).values({
		raceVideoId: RACE_VIDEO_ID,
		validationId: '88888888-8888-4888-8888-888888888888',
		status: 'ready',
		stateVersion: 2,
		byteCount: 1024,
		durationMs: 1_200_000,
		width: 1920,
		height: 1080,
		videoCodec: 'h264',
		audioCodecsJson: '[]',
		containerFormatsJson: '["mov"]',
		decodedFrameCount: 36_000,
		averageFrameRateNumerator: 30,
		averageFrameRateDenominator: 1,
		timeBaseNumerator: 1,
		timeBaseDenominator: 90_000,
		sampleAspectRatioNumerator: 1,
		sampleAspectRatioDenominator: 1,
		displayAspectRatioNumerator: 16,
		displayAspectRatioDenominator: 9,
		startTimeMs: 0,
		checksumSha256: 'a'.repeat(64),
		startedAt: timestamp,
		updatedAt: timestamp,
		completedAt: timestamp,
	});
};
