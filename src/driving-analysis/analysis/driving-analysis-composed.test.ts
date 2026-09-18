import type { WorkflowStep } from 'cloudflare:workers';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/d1';
import { expect, test, vi } from 'vitest';
import {
	car,
	driveSession,
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
import { createSqliteD1 } from '../../testing/sqlite-d1';
import { cornerClipPublication } from '../clips/clip-schema';
import { CornerClipAuthority } from '../clips/corner-clip-authority';
import { clipRenderDigest } from '../clips/corner-clip-contracts';
import { renderAcceptedCornerClips } from '../clips/corner-clips';
import { AcceptedCornerEvidence } from '../evidence/accepted-corner-evidence';
import { CornerEvidenceAuthority } from '../evidence/corner-evidence-authority';
import { CornerEvidenceReview } from '../evidence/corner-evidence-review';
import { cornerEvidenceBatch } from '../evidence/evidence-schema';
import type { TrackingWorkflowIdentity } from '../tracking/authority-contracts';
import { trackingSegment } from '../tracking/authority-schema';
import type { OutputArtifact } from '../tracking/contracts';
import { PreparedTrackViewAuthority } from '../tracking/prepared-track-view-authority';
import { R2PreparedTrackViewStore } from '../tracking/r2-prepared-track-view-store';
import { R2TrackingArtifactStore } from '../tracking/r2-tracking-artifact-store';
import {
	stagingArtifactObjectKey,
	subjectProvenanceForProfile,
	TrackingArtifactPublication,
	trackingInputDigestFor,
} from '../tracking/tracking-artifact-publication';
import { TrackingAuthority } from '../tracking/tracking-authority';
import { DrivingAnalysisAuthority } from './driving-analysis-authority';
import { completeDrivingAnalysis } from './driving-analysis-completion';
import {
	DrivingAnalysisCreationWorkflowRunner,
	RealDrivingAnalysisContainerPort,
} from './driving-analysis-creation-workflow';

const OWNER_ID = 'owner-1';
const CAR_ID = '11111111-1111-4111-8111-111111111111';
const DRIVE_ID = '22222222-2222-4222-8222-222222222222';
const RACE_VIDEO_ID = '33333333-3333-4333-8333-333333333333';
const MAP_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const ANALYSIS_ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-09-18T18:00:00.000Z');
const timestamp = NOW.toISOString();
const digest = async (bytes: Uint8Array<ArrayBuffer>) =>
	Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
		(value) => value.toString(16).padStart(2, '0'),
	).join('');
const gzip = async (value: unknown) =>
	new Uint8Array(
		await new Response(
			new Blob([JSON.stringify(value)])
				.stream()
				.pipeThrough(new CompressionStream('gzip')),
		).arrayBuffer(),
	);

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

test('composes preparation, accepted gap, exact-frame correction, Corner clips and replay on real authority', async () => {
	const sqlite = createSqliteD1();
	try {
		for (const name of readdirSync(resolve('migrations'))
			.filter((name) => /^\d+.*\.sql$/.test(name))
			.sort())
			sqlite.exec(readFileSync(resolve('migrations', name), 'utf8'));
		await seedReadyInput(sqlite.database);
		const orm = drizzle(sqlite.database);
		const r2 = new MockR2Controller();
		const store = new R2TrackingArtifactStore(r2.bucket);
		const tracking = new TrackingAuthority(sqlite.database);
		const prepared = new PreparedTrackViewAuthority(sqlite.database);
		const profile = inferenceProfileFixture();
		const analysis = new DrivingAnalysisAuthority(sqlite.database, {
			clock: () => NOW,
			id: () => ANALYSIS_ID,
		});
		const seed = {
			timestampMs: 100,
			frameIndex: 1,
			identity: 'subject',
			box: { x: 0.15, y: 0.45, width: 0.1, height: 0.1 },
		};
		const created = await analysis.create({
			ownerId: OWNER_ID,
			carId: CAR_ID,
			driveSessionId: DRIVE_ID,
			input: {
				requestId: crypto.randomUUID(),
				raceVideoId: RACE_VIDEO_ID,
				approvedTrackMapVersionId: MAP_VERSION_ID,
				raceWindow: { startTimestampMs: 100, endTimestampMs: 700 },
				subjectSeed: seed,
			},
		});
		expect(created.analysis.status).toBe('queued');
		const media = {
			prepare: vi.fn(
				async ({
					request,
					output,
				}: import('../tracking/track-view-preparation').TrackViewMediaPreparationCommand) => {
					const context = await prepared.preparationContext(
						OWNER_ID,
						request.caseId,
					);
					const bytes = new Uint8Array([1, 2, 3, 4]);
					const checksum = await digest(bytes);
					const facts = {
						preparedMediaId: request.preparedMediaId,
						caseId: request.caseId,
						sourceByteCount: 1024,
						sourceChecksumSha256: 'a'.repeat(64),
						window: request.window,
						trackView: created.analysis.sourceLayout.trackView,
						width: 1920,
						height: 720,
						averageFrameRate: { numerator: 10, denominator: 1 },
						ffmpegVersion: '7.1.2',
						pipelineVersion: 'subject-tracking.v1' as const,
						preparationInputDigest: context.input.inputDigest,
						preparationConfigurationDigest: '9'.repeat(64),
					};
					const manifest = await gzip({
						...facts,
						contractVersion: 'subject-tracking.v1',
						mediaByteCount: bytes.byteLength,
						mediaChecksumSha256: checksum,
						frames: Array.from({ length: 6 }, (_, i) => ({
							preparedFrameIndex: i,
							frameIndex: i + 1,
							timestampMs: (i + 1) * 100,
						})),
					});
					const manifestSha = await digest(manifest);
					await r2.bucket.put(output.mediaObjectKey, bytes, {
						customMetadata: { sha256: checksum },
						httpMetadata: { contentType: 'video/mp4' },
					});
					await r2.bucket.put(output.frameManifestObjectKey, manifest, {
						customMetadata: { sha256: manifestSha },
						httpMetadata: {
							contentType:
								'application/vnd.rc-mech.prepared-frame-manifest+json',
							contentEncoding: 'gzip',
						},
					});
					return {
						contractVersion: 'subject-tracking.v1',
						correlationId: request.correlationId,
						caseId: request.caseId,
						outcome: 'accepted',
						prepared: {
							...facts,
							byteCount: bytes.byteLength,
							checksumSha256: checksum,
							frameManifestByteCount: manifest.byteLength,
							frameManifestChecksumSha256: manifestSha,
							decodedFrameCount: 6,
						},
					};
				},
			),
		};
		const cache = new Map<string, unknown>();
		const step = {
			do: async (
				name: string,
				config: unknown,
				callback?: () => Promise<unknown>,
			) => {
				const execute = typeof config === 'function' ? config : callback;
				if (!execute) throw new Error('Workflow step requires a callback');
				if (!cache.has(name))
					cache.set(name, JSON.parse(JSON.stringify(await execute())));
				return structuredClone(cache.get(name));
			},
		} as unknown as WorkflowStep;
		let identity: TrackingWorkflowIdentity | undefined;
		const runner = new DrivingAnalysisCreationWorkflowRunner(
			analysis,
			new RealDrivingAnalysisContainerPort({
				authority: analysis,
				tracking,
				prepared,
				media,
				profile,
				store: new R2PreparedTrackViewStore(r2.bucket),
				clock: () => NOW,
			}),
			() => NOW,
			async (command) => {
				identity = {
					ownerId: OWNER_ID,
					analysisId: ANALYSIS_ID,
					workflowId: ANALYSIS_ID,
					runId: command.runId,
					segmentId: command.segmentId,
				};
				await tracking.createFirstSegment({
					...identity,
					order: 0,
					seed: { kind: 'initial', sourceId: null, value: command.subjectSeed },
					preparedMediaId: command.preparedMediaId,
					specificationVersion: 'tracking-segment-spec.v1',
					availabilityDeadlineAt: NOW.getTime() + 86400000,
					createdAt: timestamp,
				});
			},
		);
		const event = {
			workflowName: 'driving-analysis',
			payload: {
				kind: 'analysis-creation.v1' as const,
				ownerId: OWNER_ID,
				analysisId: ANALYSIS_ID,
				workflowId: ANALYSIS_ID,
				workflowSequence: 1,
				expectedStateVersion: 1,
			},
			instanceId: ANALYSIS_ID,
			timestamp: NOW,
		};
		await runner.run(event, step);
		await runner.run(event, step);
		expect(identity).toBeDefined();
		if (!identity) throw new Error('Creation did not dispatch Tracking');
		expect(media.prepare).toHaveBeenCalledOnce();
		const coordinator = {
			beginCommitHold: vi.fn(async () => ({
				status: 'ok' as const,
				holdId: crypto.randomUUID(),
			})),
			releaseCommitHold: vi.fn(async () => ({ status: 'ok' as const })),
			release: vi.fn(async () => ({ status: 'ok' as const })),
		};
		const publication = new TrackingArtifactPublication(
			tracking,
			store,
			coordinator,
			() => NOW,
		);
		const evidence = new AcceptedCornerEvidence(
			new CornerEvidenceAuthority(sqlite.database),
			store,
		);
		const clips = new CornerClipAuthority(sqlite.database);
		const publishProvider = async (
			current: TrackingWorkflowIdentity,
			gap: boolean,
		) => {
			const context = await tracking.workflowContext(current);
			const attemptId = crypto.randomUUID(),
				leaseId = crypto.randomUUID(),
				transferRequestId = crypto.randomUUID();
			const authority = {
				ownerId: current.ownerId,
				runId: current.runId,
				segmentId: current.segmentId,
				attemptId,
				leaseId,
				fence: 1,
			};
			await tracking.activateAttempt({
				...authority,
				expectedCurrentAttemptId: null,
				createdAt: timestamp,
			});
			await tracking.transitionAttempt({
				...authority,
				expectedState: 'active',
				nextState: 'processing',
				progress: 50,
				safeFailureCode: null,
				updatedAt: timestamp,
			});
			await tracking.transitionAttempt({
				...authority,
				expectedState: 'processing',
				nextState: 'output-ready',
				progress: 90,
				safeFailureCode: null,
				updatedAt: timestamp,
			});
			const execution = {
				...authority,
				profileDigest: context.profileDigest,
				specificationDigest: context.specificationDigest,
				transferRequestId,
			};
			await tracking.authorizeTransferGrant({
				...execution,
				role: 'observation-artifact',
				method: 'PUT',
				requestedAt: timestamp,
			});
			const publicationContext =
				await tracking.prepareArtifactPublication(execution);
			const provenance = await subjectProvenanceForProfile(profile);
			const openGap = gap
				? { startTimestampMs: 300, reason: 'missing' as const }
				: null;
			const observations = (gap ? [0.2, 0.6] : [0.2, 0.6, 0.9]).map((x, i) => ({
				timestampMs: (gap ? 100 : 400) + i * 100,
				frameIndex: (gap ? 1 : 4) + i,
				box: { x: x - 0.05, y: 0.45, width: 0.1, height: 0.1 },
				center: { x, y: 0.5 },
				visibility: 'visible',
				identityConfidence: 0.99,
				origin: 'detected',
				provenance,
			}));
			const bytes = await gzip({
				contractVersion: 'subject-observation-segment.v1',
				outcome: 'accepted',
				caseId: current.runId,
				observations,
				openGap,
				provenance,
			});
			const artifact: OutputArtifact = {
				contractVersion: 'tracking-artifact.v1',
				runId: current.runId,
				segmentId: current.segmentId,
				attemptId,
				leaseId,
				fencingToken: 1,
				specificationDigest: context.specificationDigest,
				profileDigest: context.profileDigest,
				segment: {
					observationSegmentId: current.segmentId,
					caseId: current.runId,
					byteCount: bytes.byteLength,
					checksumSha256: await digest(bytes),
					contentEncoding: 'gzip',
					mediaType: 'application/vnd.rc-mech.subject-observations+json',
					observationCount: observations.length,
					completed: !gap,
					gap: openGap,
					provenance,
					ffmpegVersion: context.prepared.ffmpegVersion,
					sourceChecksumSha256: context.prepared.sourceChecksumSha256,
					preparedChecksumSha256: context.prepared.checksumSha256,
					preparationConfigurationDigest:
						context.prepared.preparationConfigurationDigest,
					trackingInputDigest: await trackingInputDigestFor(
						publicationContext,
						current.segmentId,
						provenance,
					),
				},
			};
			r2.seed(stagingArtifactObjectKey(attemptId, transferRequestId), bytes);
			const command = { ownerId: OWNER_ID, transferRequestId, artifact };
			const accepted = await publication.publish(command);
			await evidence.commit(current);
			await analysis.publishTrackingState(
				OWNER_ID,
				ANALYSIS_ID,
				await tracking.publicState(OWNER_ID, ANALYSIS_ID, current.runId),
				timestamp,
			);
			return { accepted, command };
		};
		const first = await publishProvider(identity, true);
		expect((await analysis.get(OWNER_ID, ANALYSIS_ID)).status).toBe(
			'awaiting-reidentification',
		);
		expect(
			await completeDrivingAnalysis(sqlite.database, identity, timestamp),
		).toBe('not-ready');
		const correctionId = crypto.randomUUID();
		const correctedSeed = { ...seed, timestampMs: 400, frameIndex: 4 };
		await expect(
			tracking.reidentify(
				identity,
				correctionId,
				first.accepted.checksumSha256,
				{ ...correctedSeed, frameIndex: 5 },
				store,
			),
		).rejects.toThrow('Subject frame must match');
		const next = await tracking.reidentify(
			identity,
			correctionId,
			first.accepted.checksumSha256,
			correctedSeed,
			store,
		);
		expect(next.seed).toEqual(correctedSeed);
		await tracking.reidentify(
			identity,
			correctionId,
			first.accepted.checksumSha256,
			correctedSeed,
			store,
		);
		const continuation = { ...identity, segmentId: correctionId };
		const second = await publishProvider(continuation, false);
		expect(
			await completeDrivingAnalysis(sqlite.database, continuation, timestamp),
		).toBe('not-ready');
		const render = vi.fn(
			async (
				command: import('../clips/corner-clip-renderer').ClipRenderCommand,
			) => {
				const bytes = new Uint8Array([0, 1, 2, 3]),
					checksumSha256 = await digest(bytes);
				await r2.bucket.put(command.outputObjectKey, bytes, {
					customMetadata: { sha256: checksumSha256 },
				});
				return {
					renderId: command.request.renderId,
					caseId: continuation.runId,
					contentType: 'video/mp4' as const,
					byteCount: 4,
					checksumSha256,
					durationMs: 1100,
					renderInputDigest: await clipRenderDigest(command.request, '7.1.2'),
					sourceChecksumSha256: 'a'.repeat(64),
					ffmpegVersion: '7.1.2',
					pipelineVersion: 'corner-render.v1' as const,
					elapsedMs: 1,
				};
			},
		);
		await renderAcceptedCornerClips(continuation, clips, r2.bucket, render);
		expect(render).toHaveBeenCalledOnce();
		await publication.publish(second.command);
		expect((await evidence.commit(continuation)).status).toBe('replayed');
		await renderAcceptedCornerClips(continuation, clips, r2.bucket, render);
		expect(render).toHaveBeenCalledOnce();
		expect(
			await completeDrivingAnalysis(sqlite.database, continuation, timestamp),
		).toBe('completed');
		const review = await new CornerEvidenceReview(sqlite.database).get(
			OWNER_ID,
			ANALYSIS_ID,
		);
		expect(review).toMatchObject({ status: 'completed' });
		expect(review?.corners[0]?.passes).toMatchObject([
			{
				eligibility: 'ineligible',
				exclusionReason: 'tracking-gap',
				rank: null,
				best: false,
				provenance: { segmentId: identity.segmentId, segmentSequence: 0 },
			},
			{
				eligibility: 'eligible',
				durationMs: 100,
				rank: 1,
				best: true,
				provenance: { segmentId: correctionId, segmentSequence: 1 },
			},
		]);
		expect(
			await new CornerEvidenceReview(sqlite.database).get(
				'other-owner',
				ANALYSIS_ID,
			),
		).toBeNull();
		expect((await analysis.get(OWNER_ID, ANALYSIS_ID)).progress).toBe(100);
		expect(
			await completeDrivingAnalysis(sqlite.database, continuation, timestamp),
		).toBe('completed');
		expect(await orm.select().from(trackingSegment)).toHaveLength(2);
		expect(await orm.select().from(cornerEvidenceBatch)).toHaveLength(2);
		expect(await orm.select().from(cornerClipPublication)).toHaveLength(1);
	} finally {
		sqlite.close();
	}
});
