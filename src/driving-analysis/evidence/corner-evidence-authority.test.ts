import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, test } from 'vitest';
import {
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
import {
	inferenceProfileFixture,
	PROFILE_DIGEST,
	submissionFixture,
} from '../../testing/driving-analysis-tracking-fixtures';
import { MockR2Controller } from '../../testing/hono-fixture';
import { createSqliteD1, type SqliteD1Fixture } from '../../testing/sqlite-d1';
import {
	inferenceProfileAuthority,
	preparedTrackingMedia,
	preparedTrackingObject,
	subjectObservationArtifact,
	trackingExecutionAttempt,
	trackingRun,
	trackingRunInput,
	trackingSegment,
} from '../tracking/authority-schema';
import { R2TrackingArtifactStore } from '../tracking/r2-tracking-artifact-store';
import type { PreparedFrameManifest } from '../tracking/track-view-contracts';
import { subjectProvenanceForProfile } from '../tracking/tracking-artifact-publication';
import {
	AcceptedCornerEvidence,
	type AcceptedCornerEvidenceIdentity,
} from './accepted-corner-evidence';
import {
	CornerEvidenceAuthority,
	CornerEvidenceAuthorityError,
} from './corner-evidence-authority';
import { cornerEvidenceBatch, cornerPassEvidence } from './evidence-schema';

const OWNER_ID = 'owner-1';
const CAR_ID = '11111111-1111-4111-8111-111111111111';
const DRIVE_ID = '22222222-2222-4222-8222-222222222222';
const RACE_VIDEO_ID = '33333333-3333-4333-8333-333333333333';
const MAP_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const CORNER_ID = '55555555-5555-4555-8555-555555555555';
const ANALYSIS_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '77777777-7777-4777-8777-777777777777';
const PREPARED_MEDIA_ID = '88888888-8888-4888-8888-888888888888';
const SEGMENT_ID = '99999999-9999-4999-8999-999999999999';
const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MANIFEST_KEY = `prepared/${PREPARED_MEDIA_ID}/frame-manifest.json.gz`;
const OBSERVATION_KEY = `tracking-evidence/${RUN_ID}/${SEGMENT_ID}/${ATTEMPT_ID}/subject-observations.json.gz`;
const INPUT_DIGEST = '1'.repeat(64);
const SPECIFICATION_DIGEST = '2'.repeat(64);
const SOURCE_CHECKSUM = '3'.repeat(64);
const MEDIA_CHECKSUM = '4'.repeat(64);
const MANIFEST_CHECKSUM = '5'.repeat(64);
const OBSERVATION_CHECKSUM = '6'.repeat(64);
const CONTRACT_DIGEST = '7'.repeat(64);
const NOW = new Date('2026-08-18T20:00:00.000Z');

const migrationDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../migrations',
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
});

const identity: AcceptedCornerEvidenceIdentity = {
	ownerId: OWNER_ID,
	analysisId: ANALYSIS_ID,
	runId: RUN_ID,
	workflowId: ANALYSIS_ID,
	segmentId: SEGMENT_ID,
};

type EvidenceSourceFixture = Readonly<{
	manifestByteCount: number;
	manifestChecksum: string;
	observationByteCount: number;
	observationChecksum: string;
	observationContractDigest: string;
}>;

const seed = async (
	source: EvidenceSourceFixture = {
		manifestByteCount: 15,
		manifestChecksum: MANIFEST_CHECKSUM,
		observationByteCount: 20,
		observationChecksum: OBSERVATION_CHECKSUM,
		observationContractDigest: CONTRACT_DIGEST,
	},
) => {
	sqlite = createSqliteD1();
	sqlite.exec(migrations);
	const database = drizzle(sqlite.database);
	const timestamp = NOW.toISOString();
	await database.insert(owner).values({
		id: OWNER_ID,
		name: 'Owner',
		email: 'owner@example.com',
		emailVerified: true,
		createdAt: NOW,
		updatedAt: NOW,
		timezone: 'UTC',
	});
	await database.insert(car).values({
		id: CAR_ID,
		ownerId: OWNER_ID,
		name: 'Buggy',
		createdAt: timestamp,
	});
	await database.insert(driveSession).values({
		id: DRIVE_ID,
		carId: CAR_ID,
		startedAt: timestamp,
	});
	await database.insert(raceVideo).values({
		id: RACE_VIDEO_ID,
		ownerId: OWNER_ID,
		carId: CAR_ID,
		driveSessionId: DRIVE_ID,
		requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
		objectKey: `race-recordings/private/${RACE_VIDEO_ID}`,
		multipartUploadId: 'upload-1',
		fileName: 'Race.mov',
		contentType: 'video/quicktime',
		declaredSize: 100,
		actualSize: 100,
		partSize: 10 * 1024 * 1024,
		status: 'validating',
		createdAt: timestamp,
		updatedAt: timestamp,
		expiresAt: '2026-08-19T20:00:00.000Z',
		completedAt: timestamp,
	});
	await database.insert(raceVideoValidation).values({
		raceVideoId: RACE_VIDEO_ID,
		validationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
		status: 'ready',
		stateVersion: 2,
		byteCount: 100,
		durationMs: 400,
		width: 320,
		height: 180,
		videoCodec: 'h264',
		audioCodecsJson: '[]',
		containerFormatsJson: '["mov"]',
		decodedFrameCount: 3,
		averageFrameRateNumerator: 10,
		averageFrameRateDenominator: 1,
		timeBaseNumerator: 1,
		timeBaseDenominator: 1000,
		sampleAspectRatioNumerator: 1,
		sampleAspectRatioDenominator: 1,
		displayAspectRatioNumerator: 16,
		displayAspectRatioDenominator: 9,
		startTimeMs: 0,
		checksumSha256: SOURCE_CHECKSUM,
		startedAt: timestamp,
		updatedAt: timestamp,
		completedAt: timestamp,
	});
	await database.insert(trackLayout).values({
		id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
		name: 'Indoor clay',
		status: 'active',
		createdBy: OWNER_ID,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	await database.insert(trackMapVersion).values({
		id: MAP_VERSION_ID,
		layoutId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
		version: 1,
		stateVersion: 1,
		status: 'draft',
		createdBy: OWNER_ID,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	await database.insert(trackCorner).values({
		id: CORNER_ID,
		mapVersionId: MAP_VERSION_ID,
		key: 'turn-one',
		name: 'Turn one',
		order: 1,
		entryStartX: 0.4,
		entryStartY: 1,
		entryEndX: 0.4,
		entryEndY: 0,
		entryDirection: 'forward',
		exitStartX: 0.75,
		exitStartY: 1,
		exitEndX: 0.75,
		exitEndY: 0,
		exitDirection: 'forward',
		viewX: 0,
		viewY: 0,
		viewWidth: 1,
		viewHeight: 1,
	});
	await database.insert(trackMapReferenceFrame).values({
		id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
		mapVersionId: MAP_VERSION_ID,
		raceVideoId: RACE_VIDEO_ID,
		timestampMs: 100,
		objectKey: `track-map-reference-frames/${MAP_VERSION_ID}/frame.jpg`,
		byteCount: 3,
		checksumSha256: SOURCE_CHECKSUM,
		contentType: 'image/jpeg',
		createdBy: OWNER_ID,
		createdAt: timestamp,
	});
	await database
		.update(trackMapVersion)
		.set({
			status: 'approved',
			stateVersion: 2,
			approvedBy: OWNER_ID,
			approvedAt: timestamp,
			updatedAt: timestamp,
		})
		.where(eq(trackMapVersion.id, MAP_VERSION_ID));
	await database.insert(drivingAnalysis).values({
		id: ANALYSIS_ID,
		ownerId: OWNER_ID,
		requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
		requestDigest: '8'.repeat(64),
		carId: CAR_ID,
		driveSessionId: DRIVE_ID,
		raceVideoId: RACE_VIDEO_ID,
		raceWindowStartMs: 0,
		raceWindowEndMs: 400,
		approvedTrackMapVersionId: MAP_VERSION_ID,
		subjectSeedTimestampMs: 100,
		subjectSeedFrameIndex: 1,
		subjectSeedIdentity: 'subject-car',
		subjectBoxX: 0.15,
		subjectBoxY: 0.45,
		subjectBoxWidth: 0.1,
		subjectBoxHeight: 0.1,
		sourceLayoutVersion: 'fixed-track-view.v1',
		sourceLayoutDigest: '9'.repeat(64),
		sourceWidth: 320,
		sourceHeight: 180,
		workflowId: ANALYSIS_ID,
		workflowSequence: 1,
		status: 'queued',
		stage: 'preparation',
		progress: 0,
		stateVersion: 1,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	await database
		.update(drivingAnalysis)
		.set({ status: 'running', progress: 20, stateVersion: 2 })
		.where(eq(drivingAnalysis.id, ANALYSIS_ID));
	await database
		.update(drivingAnalysis)
		.set({ stage: 'tracking', progress: 99, stateVersion: 3 })
		.where(eq(drivingAnalysis.id, ANALYSIS_ID));
	await database.insert(inferenceProfileAuthority).values({
		profileDigest: PROFILE_DIGEST,
		contractVersion: 'inference-profile.v1',
		canonicalizationVersion: 'inference-profile-c14n.v1',
		configurationJson: JSON.stringify(inferenceProfileFixture()),
		createdAt: timestamp,
	});
	await database.insert(trackingRun).values({
		id: RUN_ID,
		analysisId: ANALYSIS_ID,
		ownerId: OWNER_ID,
		sequence: 1,
		workflowId: ANALYSIS_ID,
		profileDigest: PROFILE_DIGEST,
		inputDigest: INPUT_DIGEST,
		status: 'active',
		version: 1,
		createdAt: timestamp,
	});
	await database.insert(trackingRunInput).values({
		runId: RUN_ID,
		ownerId: OWNER_ID,
		raceVideoId: RACE_VIDEO_ID,
		sourceObjectKey: `race-recordings/private/${RACE_VIDEO_ID}`,
		sourceByteCount: 100,
		sourceChecksum: SOURCE_CHECKSUM,
		windowStartTimestampMs: 0,
		windowEndTimestampMs: 400,
		approvedTrackMapVersionId: MAP_VERSION_ID,
		sourceLayoutVersion: 'fixed-track-view.v1',
		sourceLayoutDigest: '9'.repeat(64),
		sourceWidth: 320,
		sourceHeight: 180,
		inputDigest: INPUT_DIGEST,
		createdAt: timestamp,
	});
	const prepared = {
		preparedMediaId: PREPARED_MEDIA_ID,
		caseId: RUN_ID,
		byteCount: 50,
		checksumSha256: MEDIA_CHECKSUM,
		frameManifestByteCount: source.manifestByteCount,
		frameManifestChecksumSha256: source.manifestChecksum,
		sourceByteCount: 100,
		sourceChecksumSha256: SOURCE_CHECKSUM,
		window: { startTimestampMs: 0, endTimestampMs: 400 },
		trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
		width: 160,
		height: 60,
		decodedFrameCount: 3,
		averageFrameRate: { numerator: 10, denominator: 1 },
		ffmpegVersion: '7.1.2',
		pipelineVersion: 'subject-tracking.v1' as const,
		preparationInputDigest: INPUT_DIGEST,
		preparationConfigurationDigest: 'a'.repeat(64),
	};
	await database.insert(preparedTrackingMedia).values({
		id: PREPARED_MEDIA_ID,
		runId: RUN_ID,
		descriptorJson: JSON.stringify(prepared),
		preparationInputDigest: INPUT_DIGEST,
		preparedChecksum: MEDIA_CHECKSUM,
		frameManifestChecksum: source.manifestChecksum,
		sourceChecksum: SOURCE_CHECKSUM,
		windowStartTimestampMs: 0,
		windowEndTimestampMs: 400,
		createdAt: timestamp,
	});
	await database.insert(preparedTrackingObject).values({
		preparedMediaId: PREPARED_MEDIA_ID,
		runId: RUN_ID,
		role: 'frame-manifest',
		objectKey: MANIFEST_KEY,
		byteCount: source.manifestByteCount,
		checksumSha256: source.manifestChecksum,
		contentType: 'application/vnd.rc-mech.prepared-frame-manifest+json',
		contentEncoding: 'gzip',
		createdAt: timestamp,
	});
	await database.insert(trackingSegment).values({
		id: SEGMENT_ID,
		runId: RUN_ID,
		order: 0,
		seedKind: 'initial',
		seedSourceId: null,
		seedJson: JSON.stringify(submissionFixture().trackingRequest.subjectSeed),
		preparedMediaId: PREPARED_MEDIA_ID,
		raceWindowEndTimestampMs: 400,
		profileDigest: PROFILE_DIGEST,
		specificationVersion: 'tracking-segment-spec.v1',
		specificationDigest: SPECIFICATION_DIGEST,
		availabilityDeadlineAt: NOW.getTime() + 60_000,
		currentAttemptId: null,
		authorityLeaseId: null,
		authorityFence: null,
		outcome: null,
		gapJson: null,
		acceptedArtifactId: null,
		version: 1,
		createdAt: timestamp,
	});
	await database.insert(trackingExecutionAttempt).values({
		id: ATTEMPT_ID,
		segmentId: SEGMENT_ID,
		profileDigest: PROFILE_DIGEST,
		specificationDigest: SPECIFICATION_DIGEST,
		leaseId: 'lease-1',
		fence: 1,
		state: 'completed',
		progress: 99,
		safeFailureCode: null,
		version: 1,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	await database.insert(subjectObservationArtifact).values({
		id: ATTEMPT_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		attemptId: ATTEMPT_ID,
		profileDigest: PROFILE_DIGEST,
		specificationDigest: SPECIFICATION_DIGEST,
		leaseId: 'lease-1',
		fence: 1,
		acceptedObjectKey: OBSERVATION_KEY,
		checksumSha256: source.observationChecksum,
		contractDigest: source.observationContractDigest,
		byteCount: source.observationByteCount,
		outcome: 'completed',
		gapJson: null,
		firstTimestampMs: 100,
		lastTimestampMs: 300,
		createdAt: timestamp,
	});
	await database
		.update(trackingSegment)
		.set({
			outcome: 'completed',
			acceptedArtifactId: ATTEMPT_ID,
			version: 2,
		})
		.where(eq(trackingSegment.id, SEGMENT_ID));
	return { authority: new CornerEvidenceAuthority(sqlite.database), database };
};

const measurement = {
	version: 'corner-evidence.v1' as const,
	passes: [
		{
			cornerId: CORNER_ID,
			cornerKey: 'turn-one',
			cornerOrder: 1,
			ordinal: 1,
			entry: {
				timestampMs: 150,
				beforeFrameIndex: 1,
				afterFrameIndex: 2,
			},
			exit: {
				timestampMs: 250,
				beforeFrameIndex: 2,
				afterFrameIndex: 3,
			},
			durationMs: 100,
			eligibility: 'eligible' as const,
			exclusionReason: null,
			rank: 1,
			tieGroup: 1,
			best: true,
		},
	],
};

const command = () => ({
	...identity,
	artifactId: ATTEMPT_ID,
	attemptId: ATTEMPT_ID,
	profileDigest: PROFILE_DIGEST,
	specificationDigest: SPECIFICATION_DIGEST,
	preparedMediaId: PREPARED_MEDIA_ID,
	observationObjectKey: OBSERVATION_KEY,
	observationChecksumSha256: OBSERVATION_CHECKSUM,
	observationContractDigest: CONTRACT_DIGEST,
	manifestObjectKey: MANIFEST_KEY,
	manifestChecksumSha256: MANIFEST_CHECKSUM,
	approvedTrackMapVersionId: MAP_VERSION_ID,
	measurementInputDigest: 'b'.repeat(64),
	measurementDigest: 'c'.repeat(64),
	measurement,
	createdAt: NOW.toISOString(),
});

const batchValues = (
	value = command(),
): typeof cornerEvidenceBatch.$inferInsert => ({
	artifactId: value.artifactId,
	ownerId: value.ownerId,
	analysisId: value.analysisId,
	runId: value.runId,
	workflowId: value.workflowId,
	segmentId: value.segmentId,
	attemptId: value.attemptId,
	profileDigest: value.profileDigest,
	specificationDigest: value.specificationDigest,
	preparedMediaId: value.preparedMediaId,
	observationObjectKey: value.observationObjectKey,
	observationChecksumSha256: value.observationChecksumSha256,
	observationContractDigest: value.observationContractDigest,
	manifestObjectKey: value.manifestObjectKey,
	manifestChecksumSha256: value.manifestChecksumSha256,
	approvedTrackMapVersionId: value.approvedTrackMapVersionId,
	measurementVersion: value.measurement.version,
	measurementInputDigest: value.measurementInputDigest,
	measurementDigest: value.measurementDigest,
	createdAt: value.createdAt,
});

const gzip = async (value: unknown): Promise<Uint8Array> =>
	new Uint8Array(
		await new Response(
			new Blob([`${JSON.stringify(value)}\n`])
				.stream()
				.pipeThrough(new CompressionStream('gzip')),
		).arrayBuffer(),
	);

const digest = async (bytes: Uint8Array): Promise<string> => {
	const value = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(value)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
};

describe('CornerEvidenceAuthority', () => {
	test('exposes the immutable evidence schema to Drizzle tooling', () => {
		const batchConfig = getTableConfig(cornerEvidenceBatch);
		const passConfig = getTableConfig(cornerPassEvidence);
		expect(batchConfig).toMatchObject({
			name: 'corner_evidence_batch',
			checks: expect.arrayContaining([
				expect.objectContaining({ name: 'corner_evidence_batch_digests' }),
			]),
			foreignKeys: expect.arrayContaining([
				expect.objectContaining({ reference: expect.any(Function) }),
			]),
		});
		expect(passConfig).toMatchObject({
			name: 'corner_pass_evidence',
			checks: expect.arrayContaining([
				expect.objectContaining({ name: 'corner_pass_evidence_eligibility' }),
			]),
			primaryKeys: [expect.any(Object)],
		});
		for (const foreignKey of [
			...batchConfig.foreignKeys,
			...passConfig.foreignKeys,
		])
			expect(foreignKey.reference()).toMatchObject({
				columns: expect.any(Array),
				foreignColumns: expect.any(Array),
			});
	});

	test('integrates bounded R2 contracts with one atomic D1 measurement commit', async () => {
		const profile = inferenceProfileFixture();
		const provenance = await subjectProvenanceForProfile(profile);
		const frameManifest: PreparedFrameManifest = {
			contractVersion: 'subject-tracking.v1',
			preparedMediaId: PREPARED_MEDIA_ID,
			caseId: RUN_ID,
			sourceChecksumSha256: SOURCE_CHECKSUM,
			sourceByteCount: 100,
			window: { startTimestampMs: 0, endTimestampMs: 400 },
			trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
			mediaByteCount: 50,
			mediaChecksumSha256: MEDIA_CHECKSUM,
			width: 160,
			height: 60,
			averageFrameRate: { numerator: 10, denominator: 1 },
			ffmpegVersion: '7.1.2',
			pipelineVersion: 'subject-tracking.v1',
			preparationInputDigest: INPUT_DIGEST,
			preparationConfigurationDigest: 'a'.repeat(64),
			frames: [
				{ preparedFrameIndex: 0, frameIndex: 1, timestampMs: 100 },
				{ preparedFrameIndex: 1, frameIndex: 2, timestampMs: 200 },
				{ preparedFrameIndex: 2, frameIndex: 3, timestampMs: 300 },
			],
		};
		const segment = {
			contractVersion: 'subject-observation-segment.v1' as const,
			outcome: 'accepted' as const,
			caseId: RUN_ID,
			observations: [
				{
					timestampMs: 100,
					frameIndex: 1,
					box: { x: 0.15, y: 0.45, width: 0.1, height: 0.1 },
					center: { x: 0.2, y: 0.5 },
					visibility: 'visible' as const,
					identityConfidence: 0.99,
					origin: 'detected' as const,
					provenance,
				},
				{
					timestampMs: 200,
					frameIndex: 2,
					box: { x: 0.55, y: 0.45, width: 0.1, height: 0.1 },
					center: { x: 0.6, y: 0.5 },
					visibility: 'visible' as const,
					identityConfidence: 0.99,
					origin: 'detected' as const,
					provenance,
				},
				{
					timestampMs: 300,
					frameIndex: 3,
					box: { x: 0.85, y: 0.45, width: 0.1, height: 0.1 },
					center: { x: 0.9, y: 0.5 },
					visibility: 'visible' as const,
					identityConfidence: 0.99,
					origin: 'detected' as const,
					provenance,
				},
			],
			openGap: null,
			provenance,
		};
		const [manifestBytes, observationBytes] = await Promise.all([
			gzip(frameManifest),
			gzip(segment),
		]);
		const source = {
			manifestByteCount: manifestBytes.byteLength,
			manifestChecksum: await digest(manifestBytes),
			observationByteCount: observationBytes.byteLength,
			observationChecksum: await digest(observationBytes),
			observationContractDigest: await digest(
				new TextEncoder().encode(`${JSON.stringify(segment)}\n`),
			),
		};
		const value = await seed(source);
		const r2 = new MockR2Controller();
		r2.seed(MANIFEST_KEY, manifestBytes);
		r2.seed(OBSERVATION_KEY, observationBytes);
		const evidence = new AcceptedCornerEvidence(
			value.authority,
			new R2TrackingArtifactStore(r2.bucket),
			() => NOW,
		);
		await expect(evidence.commit(identity)).resolves.toMatchObject({
			status: 'committed',
			measurement: {
				version: 'corner-evidence.v1',
				passes: [
					{
						cornerId: CORNER_ID,
						durationMs: 100,
						eligibility: 'eligible',
						rank: 1,
						best: true,
					},
				],
			},
		});
		expect(await value.database.select().from(cornerEvidenceBatch)).toEqual([
			expect.objectContaining({
				artifactId: ATTEMPT_ID,
				observationChecksumSha256: source.observationChecksum,
				manifestChecksumSha256: source.manifestChecksum,
				measurementVersion: 'corner-evidence.v1',
			}),
		]);
	});

	test('atomically commits and replays provenance-bound immutable evidence', async () => {
		const value = await seed();
		expect(
			await value.database
				.select({ id: subjectObservationArtifact.id })
				.from(subjectObservationArtifact),
		).toEqual([{ id: ATTEMPT_ID }]);
		const context = await value.authority.load(identity);
		expect(context).toMatchObject({
			artifact: { id: ATTEMPT_ID, acceptedObjectKey: OBSERVATION_KEY },
			manifestObject: { objectKey: MANIFEST_KEY },
			approvedTrackMapVersionId: MAP_VERSION_ID,
			corners: [{ id: CORNER_ID, key: 'turn-one' }],
			existingMeasurement: null,
		});
		expect({
			artifactId: context.artifact.id,
			attemptId: context.artifact.attemptId,
			profileDigest: context.artifact.profileDigest,
			specificationDigest: context.artifact.specificationDigest,
			preparedMediaId: context.prepared.preparedMediaId,
			observationObjectKey: context.artifact.acceptedObjectKey,
			observationChecksumSha256: context.artifact.checksumSha256,
			observationContractDigest: context.artifact.contractDigest,
			manifestObjectKey: context.manifestObject.objectKey,
			manifestChecksumSha256: context.manifestObject.checksumSha256,
			approvedTrackMapVersionId: context.approvedTrackMapVersionId,
		}).toEqual({
			artifactId: command().artifactId,
			attemptId: command().attemptId,
			profileDigest: command().profileDigest,
			specificationDigest: command().specificationDigest,
			preparedMediaId: command().preparedMediaId,
			observationObjectKey: command().observationObjectKey,
			observationChecksumSha256: command().observationChecksumSha256,
			observationContractDigest: command().observationContractDigest,
			manifestObjectKey: command().manifestObjectKey,
			manifestChecksumSha256: command().manifestChecksumSha256,
			approvedTrackMapVersionId: command().approvedTrackMapVersionId,
		});
		await expect(value.authority.commit(command())).resolves.toEqual({
			status: 'committed',
			measurement,
		});
		await expect(value.authority.commit(command())).resolves.toEqual({
			status: 'replayed',
			measurement,
		});
		expect(
			await value.database.select().from(cornerEvidenceBatch),
		).toHaveLength(1);
		expect(await value.database.select().from(cornerPassEvidence)).toEqual([
			expect.objectContaining({
				batchArtifactId: ATTEMPT_ID,
				cornerId: CORNER_ID,
				durationMs: 100,
				rank: 1,
				best: true,
			}),
		]);
	});

	test('rejects stale lifecycle authority and database mutation', async () => {
		const value = await seed();
		await value.authority.commit(command());
		if (!sqlite) throw new Error('SQLite fixture unavailable');
		await expect(
			sqlite.database
				.prepare(
					"UPDATE corner_evidence_batch SET measurement_digest = 'changed'",
				)
				.run(),
		).rejects.toThrow(/immutable/);
		await value.database
			.update(trackingRun)
			.set({ status: 'cancelled', version: 2, completedAt: NOW.toISOString() })
			.where(eq(trackingRun.id, RUN_ID));
		await expect(value.authority.load(identity)).rejects.toEqual(
			new CornerEvidenceAuthorityError('STALE_AUTHORITY'),
		);
	});

	test('rejects malformed commands, unknown corners, and excessive evidence', async () => {
		const value = await seed();
		const firstPass = measurement.passes[0];
		if (!firstPass) throw new Error('missing pass fixture');
		await expect(
			value.authority.commit({
				...command(),
				observationChecksumSha256: '0'.repeat(64),
			}),
		).rejects.toEqual(new CornerEvidenceAuthorityError('STALE_AUTHORITY'));
		await expect(
			value.authority.commit({
				...command(),
				measurement: {
					...measurement,
					passes: [{ ...firstPass, cornerId: 'unknown-corner' }],
				},
			}),
		).rejects.toEqual(new CornerEvidenceAuthorityError('STALE_AUTHORITY'));
		await expect(
			value.authority.commit({
				...command(),
				measurement: {
					...measurement,
					passes: Array(10_001).fill(firstPass),
				},
			}),
		).rejects.toEqual(new CornerEvidenceAuthorityError('STALE_AUTHORITY'));
		await expect(
			value.authority.commit({
				...command(),
				measurement: {
					...measurement,
					version: 'corner-evidence.v2' as never,
				},
			}),
		).rejects.toEqual(new CornerEvidenceAuthorityError('STALE_AUTHORITY'));
	});

	test('persists nullable ineligible crossings and rejects changed replays', async () => {
		const value = await seed();
		const ineligible = {
			...command(),
			measurement: {
				version: 'corner-evidence.v1' as const,
				passes: [
					{
						cornerId: CORNER_ID,
						cornerKey: 'turn-one',
						cornerOrder: 1,
						ordinal: 1,
						entry: null,
						exit: null,
						durationMs: null,
						eligibility: 'ineligible' as const,
						exclusionReason: 'race-window' as const,
						rank: null,
						tieGroup: null,
						best: false,
					},
				],
			},
		};
		await expect(value.authority.commit(ineligible)).resolves.toMatchObject({
			measurement: ineligible.measurement,
		});
		await expect(
			value.authority.commit({
				...ineligible,
				measurementDigest: 'd'.repeat(64),
			}),
		).rejects.toEqual(new CornerEvidenceAuthorityError('STALE_AUTHORITY'));
	});

	test('rejects conflicting stored source and measurement versions', async () => {
		const sourceConflict = await seed();
		await sourceConflict.database.insert(cornerEvidenceBatch).values({
			...batchValues(),
			ownerId: 'other-owner',
		});
		await expect(sourceConflict.authority.load(identity)).rejects.toEqual(
			new CornerEvidenceAuthorityError('STALE_AUTHORITY'),
		);

		sqlite?.close();
		sqlite = undefined;
		const versionConflict = await seed();
		await versionConflict.database.insert(cornerEvidenceBatch).values({
			...batchValues(),
			measurementVersion: 'corner-evidence.v2',
		});
		await expect(versionConflict.authority.load(identity)).rejects.toEqual(
			new CornerEvidenceAuthorityError('STALE_AUTHORITY'),
		);
	});

	test.each(['failure', 'no-op'] as const)(
		'maps a D1 batch $case without publishing partial evidence',
		async (batchCase) => {
			const value = await seed();
			if (!sqlite) throw new Error('SQLite fixture unavailable');
			const database = sqlite.database;
			const wrapped: D1Database = {
				prepare: (query) => database.prepare(query),
				exec: (query) => database.exec(query),
				withSession: (constraintOrBookmark) =>
					database.withSession(constraintOrBookmark),
				dump: () => database.dump(),
				batch:
					batchCase === 'failure'
						? async () => {
								throw new Error('private D1 failure');
							}
						: async <T>(statements: D1PreparedStatement[]) =>
								statements.map(
									() =>
										({
											success: true,
											results: [],
											meta: {
												duration: 0,
												changes: 0,
												last_row_id: 0,
												changed_db: false,
												size_after: 0,
												rows_read: 0,
												rows_written: 0,
											},
										}) as D1Result<T>,
								),
			};
			await expect(
				new CornerEvidenceAuthority(wrapped).commit(command()),
			).rejects.toEqual(new CornerEvidenceAuthorityError('STALE_AUTHORITY'));
			expect(await value.database.select().from(cornerEvidenceBatch)).toEqual(
				[],
			);
		},
	);
});
