import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import sharedMeasurement from '../../../containers/driving-analysis/tests/fixtures/subject-tracking/deterministic-measurement.json';
import observations from '../../../containers/driving-analysis/tests/fixtures/subject-tracking/observations-complete-accepted.json';
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
} from '../../testing/driving-analysis-tracking-fixtures';
import { MockR2Controller } from '../../testing/hono-fixture';
import { createSqliteD1, type SqliteD1Fixture } from '../../testing/sqlite-d1';
import type { AppEnv } from '../../types';
import { completeDrivingAnalysis } from '../analysis/driving-analysis-completion';
import { cornerClip, cornerClipPublication } from '../clips/clip-schema';
import {
	ClipAuthorityError,
	CornerClipAuthority,
} from '../clips/corner-clip-authority';
import {
	type ClipArtifact,
	clipRenderDigest,
	clipSpecificationSchema,
} from '../clips/corner-clip-contracts';
import { createCornerClipRoutes } from '../clips/corner-clip-routes';
import {
	buildClipSpecification,
	cornerClipRenderer,
	renderAcceptedCornerClips,
} from '../clips/corner-clips';
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
import { subjectObservationSegmentSchema } from '../tracking/contracts';
import { R2TrackingArtifactStore } from '../tracking/r2-tracking-artifact-store';
import {
	type PreparedFrameManifest,
	preparedFrameManifestSchema,
} from '../tracking/track-view-contracts';
import { subjectProvenanceForProfile } from '../tracking/tracking-artifact-publication';
import { TrackingAuthority } from '../tracking/tracking-authority';
import {
	AcceptedCornerEvidence,
	type AcceptedCornerEvidenceIdentity,
} from './accepted-corner-evidence';
import type { CornerEvidenceMeasurement } from './corner-evidence';
import {
	CornerEvidenceAuthority,
	CornerEvidenceAuthorityError,
} from './corner-evidence-authority';
import { CornerEvidenceReview } from './corner-evidence-review';
import { cornerEvidenceBatch, cornerPassEvidence } from './evidence-schema';

describe('private Corner clips on real SQL authority', () => {
	const setup = async (
		passes: CornerEvidenceMeasurement['passes'] = measurement.passes,
	) => {
		const segment = { ...observations, caseId: RUN_ID };
		const bytes = await gzip(segment);
		const source = {
			manifestByteCount: 15,
			manifestChecksum: MANIFEST_CHECKSUM,
			observationByteCount: bytes.byteLength,
			observationChecksum: await digest(bytes),
			observationContractDigest: await digest(
				new TextEncoder().encode(`${JSON.stringify(segment)}\n`),
			),
		};
		const value = await seed(source);
		await value.authority.commit({
			...command(),
			measurement: { version: 'corner-evidence.v1', passes },
			observationChecksumSha256: source.observationChecksum,
			observationContractDigest: source.observationContractDigest,
		});
		const clips = new CornerClipAuthority(sqlite!.database);
		const r2 = new MockR2Controller();
		r2.seed(OBSERVATION_KEY, bytes);
		const render = async (
			input: import('../clips/corner-clip-renderer').ClipRenderCommand,
		): Promise<ClipArtifact> => {
			const bytes = new Uint8Array([1, 2, 3, 4]);
			const checksumSha256 = await digest(bytes);
			await r2.bucket.put(input.outputObjectKey, bytes, {
				customMetadata: { sha256: checksumSha256 },
			});
			return {
				renderId: input.request.renderId,
				caseId: RUN_ID,
				contentType: 'video/mp4',
				byteCount: 4,
				checksumSha256,
				durationMs: 1100,
				renderInputDigest: await clipRenderDigest(input.request, '7.1.2'),
				sourceChecksumSha256: SOURCE_CHECKSUM,
				ffmpegVersion: '7.1.2',
				pipelineVersion: 'corner-render.v1',
				elapsedMs: 1,
			};
		};
		return { ...value, clips, r2, render, segment };
	};

	test('completes the current run only after every eligible clip has a verified receipt', async () => {
		const value = await setup();
		if (!sqlite) throw new Error('Missing SQL fixture');
		await expect(
			completeDrivingAnalysis(sqlite.database, identity, NOW.toISOString()),
		).resolves.toBe('not-ready');
		await renderAcceptedCornerClips(
			identity,
			value.clips,
			value.r2.bucket,
			value.render,
		);
		await expect(
			completeDrivingAnalysis(sqlite.database, identity, NOW.toISOString()),
		).resolves.toBe('completed');
		const review = new CornerEvidenceReview(sqlite.database);
		expect(
			await new TrackingAuthority(sqlite.database).publicState(
				OWNER_ID,
				ANALYSIS_ID,
				RUN_ID,
			),
		).toMatchObject({
			lifecycle: 'completed',
			progress: 100,
			waitReason: null,
			safeFailureCode: null,
		});
		expect(await review.get(OWNER_ID, ANALYSIS_ID)).toMatchObject({
			status: 'completed',
			stateVersion: 4,
		});
		await expect(
			completeDrivingAnalysis(
				sqlite.database,
				identity,
				'2026-08-18T21:00:00.000Z',
			),
		).resolves.toBe('completed');
		expect(await review.get(OWNER_ID, ANALYSIS_ID)).toMatchObject({
			status: 'completed',
			stateVersion: 4,
		});
	});

	test('requires a measured batch but completes a run with no eligible clips', async () => {
		await seed();
		if (!sqlite) throw new Error('Missing SQL fixture');
		await expect(
			completeDrivingAnalysis(sqlite.database, identity, NOW.toISOString()),
		).resolves.toBe('not-ready');
		sqlite.close();
		await setup([]);
		await expect(
			completeDrivingAnalysis(sqlite.database, identity, NOW.toISOString()),
		).resolves.toBe('completed');
	});

	test.each(['cancelled', 'failed', 'deleting'] as const)(
		'rejects finalization after the analysis becomes %s',
		async (status) => {
			const value = await setup([]);
			if (!sqlite) throw new Error('Missing SQL fixture');
			await value.database
				.update(drivingAnalysis)
				.set({ status, stateVersion: 4 })
				.where(eq(drivingAnalysis.id, ANALYSIS_ID));
			await expect(
				completeDrivingAnalysis(sqlite.database, identity, NOW.toISOString()),
			).resolves.toBe('stale');
			const run = await value.database.select().from(trackingRun).get();
			expect(run).toMatchObject({ status: 'active', completedAt: null });
		},
	);

	test('rejects another owner or superseded Workflow at finalization', async () => {
		await setup([]);
		if (!sqlite) throw new Error('Missing SQL fixture');
		for (const staleIdentity of [
			{ ...identity, ownerId: 'other-owner' },
			{ ...identity, workflowId: 'superseded-workflow' },
		]) {
			await expect(
				completeDrivingAnalysis(
					sqlite.database,
					staleIdentity,
					NOW.toISOString(),
				),
			).resolves.toBe('stale');
		}
	});

	test('builds fixed Track-view specs, publishes once, and privately streams every eligible clip', async () => {
		const value = await setup();
		await renderAcceptedCornerClips(
			identity,
			value.clips,
			value.r2.bucket,
			value.render,
		);
		await renderAcceptedCornerClips(
			identity,
			value.clips,
			value.r2.bucket,
			async () => {
				throw new Error('unexpected replay render');
			},
		);
		const rows = await value.clips.list(OWNER_ID, ANALYSIS_ID);
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(JSON.parse(row.clip.specificationJson)).toMatchObject({
			runId: RUN_ID,
			sourceChecksumSha256: SOURCE_CHECKSUM,
			trackMapVersion: MAP_VERSION_ID,
			entryTimestampMs: 150,
			exitTimestampMs: 250,
			cornerView: { x: 0, y: 0, width: 1, height: 1 },
			overlay: { subjectCenter: { x: 0.4, y: 0.5 } },
		});
		const app = new Hono<AppEnv>();
		app.use('*', async (c, next) => {
			c.set('userId', c.req.header('x-test-owner') ?? OWNER_ID);
			await next();
		});
		app.route('/', createCornerClipRoutes());
		const env = {
			DB: sqlite!.database,
			ANALYSIS_MEDIA: value.r2.bucket,
		} as Env;
		const get = vi.spyOn(value.r2.bucket, 'get');
		const path = `/driving-analyses/${ANALYSIS_ID}/clips/${row.clip.id}/content`;
		const request = (headers: Record<string, string> = {}, method = 'GET') =>
			app.request(path, { headers, method }, env);
		const response = await request({ range: 'bytes=1-2' });
		expect(response.status).toBe(206);
		expect(get).toHaveBeenCalledWith(
			row.publication!.objectKey,
			expect.objectContaining({ range: { offset: 1, length: 2 } }),
		);
		expect([...new Uint8Array(await (await request()).arrayBuffer())]).toEqual([
			1, 2, 3, 4,
		]);
		expect(response.headers.get('content-range')).toBe('bytes 1-2/4');
		expect((await request({}, 'HEAD')).status).toBe(200);
		expect(
			(await request({ 'if-none-match': response.headers.get('etag')! }))
				.status,
		).toBe(304);
		expect((await request({ range: 'bytes=99-' })).status).toBe(416);
		expect((await request({ 'x-test-owner': 'other' })).status).toBe(404);
		const listing = await app.request(
			`/driving-analyses/${ANALYSIS_ID}/clips`,
			{},
			env,
		);
		const publicBody = await listing.text();
		expect(publicBody).toContain('"status":"ready"');
		expect(publicBody).not.toContain('corner-clips/');
		expect(publicBody).not.toContain(OBSERVATION_KEY);
		get.mockResolvedValueOnce(null);
		expect((await request()).status).toBe(409);
		await value.r2.bucket.delete(row.publication!.objectKey);
		expect((await request()).status).toBe(409);
	});

	test('rejects missing, corrupted, or wrong-run observations and never renders excluded passes', async () => {
		const value = await setup();
		const bytes = await value.r2.bucket.get(OBSERVATION_KEY);
		await value.r2.bucket.delete(OBSERVATION_KEY);
		await expect(
			renderAcceptedCornerClips(
				identity,
				value.clips,
				value.r2.bucket,
				value.render,
			),
		).rejects.toThrow('CLIP_EVIDENCE_UNAVAILABLE');
		value.r2.seed(OBSERVATION_KEY, new Uint8Array([1]));
		await expect(
			renderAcceptedCornerClips(
				identity,
				value.clips,
				value.r2.bucket,
				value.render,
			),
		).rejects.toThrow('CLIP_EVIDENCE_INVALID');
		value.r2.seed(OBSERVATION_KEY, new Uint8Array(await bytes!.arrayBuffer()));
		await expect(
			renderAcceptedCornerClips(
				{ ...identity, segmentId: 'unknown' },
				value.clips,
				value.r2.bucket,
				value.render,
			),
		).resolves.toBeUndefined();
		const input = (await value.clips.inputs(identity))[0]!;
		const segment = subjectObservationSegmentSchema.parse(value.segment);
		expect(() =>
			buildClipSpecification(
				{ ...input, pass: { ...input.pass, entryBeforeFrameIndex: -1 } },
				segment,
			),
		).toThrow('CLIP_EVIDENCE_INVALID');
		for (const pass of [
			{ ...input.pass, entryAfterFrameIndex: -1 },
			{ ...input.pass, entryTimestampMs: null },
			{ ...input.pass, exitTimestampMs: null },
			{ ...input.pass, eligibility: 'ineligible' as const },
		])
			expect(() => buildClipSpecification({ ...input, pass }, segment)).toThrow(
				'CLIP_EVIDENCE_INVALID',
			);
		const reverse = buildClipSpecification(
			{
				...input,
				corner: {
					...input.corner,
					entryDirection: 'reverse',
					exitDirection: 'reverse',
				},
				pass: {
					...input.pass,
					entryTimestampMs: 150.25,
					exitTimestampMs: 250.75,
				},
			},
			segment,
		);
		expect(reverse).toMatchObject({
			entryTimestampMs: 150,
			exitTimestampMs: 251,
			overlay: {
				entryGate: { direction: 'negative' },
				exitGate: { direction: 'negative' },
			},
		});
	});

	test('renders all eligible passes and omits excluded traversals', async () => {
		const pass = measurement.passes[0]!;
		const value = await setup([
			pass,
			{ ...pass, ordinal: 2 },
			{
				...pass,
				ordinal: 3,
				eligibility: 'ineligible',
				exclusionReason: 'tracking-gap',
				durationMs: null,
				rank: null,
				tieGroup: null,
				best: false,
			},
		]);
		await cornerClipRenderer({
			DB: sqlite!.database,
			ANALYSIS_MEDIA: value.r2.bucket,
			RACE_VIDEO_MEDIA_CONTAINER: {
				getByName: (name) => {
					expect(name).toMatch(/^corner-render-/);
					return { renderCornerClip: value.render };
				},
			},
		})(identity);
		expect(
			(await value.clips.list(OWNER_ID, ANALYSIS_ID))
				.map((row) => row.clip.ordinal)
				.sort(),
		).toEqual([1, 2]);
		for (const table of [cornerClip, cornerClipPublication]) {
			const config = getTableConfig(table);
			expect(config.name).toMatch(/^corner_clip/);
			for (const key of config.foreignKeys)
				expect(key.reference().foreignColumns.length).toBeGreaterThan(0);
		}
	});

	test.each([undefined, { getByName: () => ({}) }])(
		'fails closed without the configured renderer capability',
		async (binding) => {
			const value = await setup();
			await expect(
				cornerClipRenderer({
					DB: sqlite!.database,
					ANALYSIS_MEDIA: value.r2.bucket,
					RACE_VIDEO_MEDIA_CONTAINER: binding,
				})(identity),
			).rejects.toThrow('CLIP_RENDER_UNAVAILABLE');
			expect(await value.database.select().from(cornerClipPublication)).toEqual(
				[],
			);
		},
	);

	test('checks the decompressed contract digest and bound run identity', async () => {
		const value = await setup();
		const inputs = await value.clips.inputs(identity);
		const first = inputs[0]!;
		const spy = vi.spyOn(value.clips, 'inputs');
		spy.mockResolvedValue([
			{
				...first,
				batch: { ...first.batch, observationContractDigest: '0'.repeat(64) },
			},
		]);
		await expect(
			renderAcceptedCornerClips(
				identity,
				value.clips,
				value.r2.bucket,
				value.render,
			),
		).rejects.toThrow('CLIP_EVIDENCE_INVALID');
		const wrongRun = { ...value.segment, caseId: 'other-run' };
		const compressed = await gzip(wrongRun);
		value.r2.seed(OBSERVATION_KEY, compressed);
		spy.mockResolvedValue([
			{
				...first,
				batch: {
					...first.batch,
					observationChecksumSha256: await digest(compressed),
					observationContractDigest: await digest(
						new TextEncoder().encode(`${JSON.stringify(wrongRun)}\n`),
					),
				},
			},
		]);
		await expect(
			renderAcceptedCornerClips(
				identity,
				value.clips,
				value.r2.bucket,
				value.render,
			),
		).rejects.toThrow('CLIP_EVIDENCE_INVALID');
	});

	test('hides deleting and deleted evidence and returns stable pending/unavailable states', async () => {
		const value = await setup();
		await expect(
			renderAcceptedCornerClips(
				identity,
				value.clips,
				value.r2.bucket,
				async () => {
					throw new Error('container failure');
				},
			),
		).rejects.toThrow('container failure');
		const row = (await value.clips.list(OWNER_ID, ANALYSIS_ID))[0]!;
		const app = new Hono<AppEnv>();
		app.use('*', async (c, next) => {
			c.set('userId', OWNER_ID);
			await next();
		});
		app.route('/', createCornerClipRoutes());
		const env = {
			DB: sqlite!.database,
			ANALYSIS_MEDIA: value.r2.bucket,
		} as Env;
		const listing = `/driving-analyses/${ANALYSIS_ID}/clips`;
		expect(await (await app.request(listing, {}, env)).json()).toMatchObject({
			clips: [{ status: 'not-ready', checksum: null, durationMs: null }],
		});
		await value.database
			.update(drivingAnalysis)
			.set({ status: 'deleting', stateVersion: 4 })
			.where(eq(drivingAnalysis.id, ANALYSIS_ID));
		expect((await app.request(listing, {}, env)).status).toBe(410);
		await value.database
			.update(drivingAnalysis)
			.set({ status: 'deleted', stateVersion: 5 })
			.where(eq(drivingAnalysis.id, ANALYSIS_ID));
		await expect(
			value.clips.owned(OWNER_ID, ANALYSIS_ID, row.clip.id),
		).rejects.toEqual(new ClipAuthorityError('DELETED'));
		expect(
			(await app.request(listing, {}, { ...env, DB: undefined })).status,
		).toBe(503);
	});

	test.each([
		'renderId',
		'caseId',
		'sourceChecksumSha256',
		'checksumSha256',
		'renderInputDigest',
		'objectKey',
	])('rejects conflicting publication %s', async (field) => {
		const value = await setup();
		let original: ClipArtifact | undefined;
		await renderAcceptedCornerClips(
			identity,
			value.clips,
			value.r2.bucket,
			async (input) => {
				original = await value.render(input);
				return original;
			},
		);
		const row = (await value.clips.list(OWNER_ID, ANALYSIS_ID))[0]!;
		await expect(
			value.clips.publish(
				row.clip,
				{
					...original!,
					...(field === 'objectKey' ? {} : { [field]: 'different' }),
				},
				field === 'objectKey' ? 'other' : row.publication!.objectKey,
			),
		).rejects.toEqual(new ClipAuthorityError('STALE_AUTHORITY'));
	});

	test.each([false, true])(
		'removes a late deletion upload, including an existing receipt: %s',
		async (published) => {
			const value = await setup();
			let key = '';
			await expect(
				renderAcceptedCornerClips(
					identity,
					value.clips,
					value.r2.bucket,
					async (input) => {
						const artifact = await value.render(input);
						key = input.outputObjectKey;
						if (published) {
							const row = (await value.clips.list(OWNER_ID, ANALYSIS_ID))[0]!;
							await value.clips.publish(row.clip, artifact, key);
						}
						await value.database
							.update(drivingAnalysis)
							.set({ status: 'deleting', stateVersion: 4 })
							.where(eq(drivingAnalysis.id, ANALYSIS_ID));
						return artifact;
					},
				),
			).rejects.toEqual(new ClipAuthorityError('DELETED'));
			expect(await value.r2.bucket.head(key)).toBeNull();
		},
	);

	test('fences late cancellation and cannot republish another input or owner', async () => {
		const value = await setup();
		await expect(
			renderAcceptedCornerClips(
				identity,
				value.clips,
				value.r2.bucket,
				async (input) => {
					const artifact = await value.render(input);
					await value.database
						.update(trackingRun)
						.set({
							status: 'cancelled',
							version: 2,
							completedAt: NOW.toISOString(),
						})
						.where(eq(trackingRun.id, RUN_ID));
					return artifact;
				},
			),
		).rejects.toEqual(new ClipAuthorityError('STALE_AUTHORITY'));
		expect(await value.database.select().from(cornerClipPublication)).toEqual(
			[],
		);
		const row = (await value.clips.list(OWNER_ID, ANALYSIS_ID))[0]!;
		await expect(
			value.clips.owned(OWNER_ID, ANALYSIS_ID, row.clip.id),
		).rejects.toEqual(new ClipAuthorityError('NOT_READY'));
		await expect(
			value.clips.owned(OWNER_ID, ANALYSIS_ID, 'unknown'),
		).rejects.toEqual(new ClipAuthorityError('NOT_FOUND'));
		await expect(value.clips.list('other', ANALYSIS_ID)).rejects.toEqual(
			new ClipAuthorityError('NOT_FOUND'),
		);
		const specification = clipSpecificationSchema.parse(
			JSON.parse(row.clip.specificationJson),
		);
		await expect(
			value.clips.plan(
				{ ...identity, runId: 'other' },
				{ batchArtifactId: ATTEMPT_ID, cornerId: CORNER_ID, ordinal: 1 },
				specification,
				row.clip.inputDigest,
				{ objectKey: 'source', byteCount: 100 },
			),
		).rejects.toThrow();
	});
});

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
		seedJson: JSON.stringify(sharedMeasurement.seed),
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
	test('reviews only the current owner-scoped run with safe timing provenance', async () => {
		const value = await seed();
		if (!sqlite) throw new Error('missing fixture');
		const review = new CornerEvidenceReview(sqlite.database);
		await expect(review.get('other-owner', ANALYSIS_ID)).resolves.toBeNull();
		await expect(review.get(OWNER_ID, 'missing')).resolves.toBeNull();
		expect(await review.get(OWNER_ID, ANALYSIS_ID)).toMatchObject({
			analysisId: ANALYSIS_ID,
			corners: [{ name: 'Turn one', passes: [] }],
		});
		await value.authority.commit({
			...command(),
			measurement: {
				...measurement,
				passes: [
					...measurement.passes,
					{
						cornerId: CORNER_ID,
						cornerKey: 'turn-one',
						cornerOrder: 1,
						ordinal: 2,
						entry: null,
						exit: null,
						durationMs: null,
						eligibility: 'ineligible',
						exclusionReason: 'tracking-gap',
						rank: null,
						tieGroup: null,
						best: false,
					},
				],
			},
		});
		const result = await review.get(OWNER_ID, ANALYSIS_ID);
		expect(result).toMatchObject({
			runId: RUN_ID,
			corners: [
				{
					name: 'Turn one',
					passes: [
						{
							durationMs: 100,
							rank: 1,
							best: true,
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
							provenance: {
								segmentId: SEGMENT_ID,
								profileDigest: PROFILE_DIGEST,
							},
						},
						{
							entry: null,
							exit: null,
							rank: null,
							best: false,
							exclusionReason: 'tracking-gap',
						},
					],
				},
			],
		});
		expect(JSON.stringify(result)).not.toMatch(
			/attemptId|leaseId|fence|objectKey|transfer|tracking-evidence\//,
		);
		await value.database.update(drivingAnalysis).set({
			status: 'failed',
			stateVersion: sql`${drivingAnalysis.stateVersion} + 1`,
		});
		await value.database.update(drivingAnalysis).set({
			workflowId: crypto.randomUUID(),
			workflowSequence: 2,
			status: 'queued',
			stage: 'preparation',
			progress: 0,
			stateVersion: sql`${drivingAnalysis.stateVersion} + 1`,
		});
		expect(await review.get(OWNER_ID, ANALYSIS_ID)).toMatchObject({
			runId: null,
			corners: [{ passes: [] }],
		});
	});
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
		const scenario = sharedMeasurement.cases[0];
		if (!scenario) throw new Error('missing complete measurement fixture');
		const frameManifest: PreparedFrameManifest =
			preparedFrameManifestSchema.parse({
				...sharedMeasurement.manifest,
				caseId: RUN_ID,
				window: { startTimestampMs: 0, endTimestampMs: 400 },
				frames: sharedMeasurement.manifest.frames.slice(0, scenario.frameCount),
			});
		const segment = {
			...scenario.segment,
			caseId: RUN_ID,
			observations: scenario.segment.observations.map((observation) => ({
				...observation,
				provenance,
			})),
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
		);
		const context = await value.authority.load(identity);
		expect(context.seed).toEqual(sharedMeasurement.seed);
		expect(context.corners).toEqual(sharedMeasurement.corners);
		await expect(evidence.commit(identity)).resolves.toEqual({
			status: 'committed',
			measurement: scenario.expected,
		});
		await expect(evidence.commit(identity)).resolves.toEqual({
			status: 'replayed',
			measurement: scenario.expected,
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
				batchMeasurementDigest: command().measurementDigest,
				cornerId: CORNER_ID,
				durationMs: 100,
				rank: 1,
				best: true,
			}),
		]);
	});

	test.each(['before-first-commit', 'before-replay'] as const)(
		'retains pinned map authority after retirement $case',
		async (retirement) => {
			const value = await seed();
			if (retirement === 'before-replay')
				await value.authority.commit(command());
			await value.database
				.update(trackMapVersion)
				.set({
					status: 'retired',
					stateVersion: 3,
					retiredAt: NOW.toISOString(),
				})
				.where(eq(trackMapVersion.id, MAP_VERSION_ID));
			await expect(value.authority.load(identity)).resolves.toMatchObject({
				approvedTrackMapVersionId: MAP_VERSION_ID,
				corners: [{ id: CORNER_ID }],
			});
			await expect(value.authority.commit(command())).resolves.toEqual({
				status: retirement === 'before-first-commit' ? 'committed' : 'replayed',
				measurement,
			});
			await expect(value.authority.load(identity)).resolves.toMatchObject({
				existingMeasurement: measurement,
			});
			expect(
				await value.database.select().from(cornerEvidenceBatch),
			).toHaveLength(1);
			expect(
				await value.database.select().from(cornerPassEvidence),
			).toHaveLength(1);
		},
	);

	test('atomically fences concurrent conflicting measurements at the child rows', async () => {
		const value = await seed();
		if (!sqlite) throw new Error('SQLite fixture unavailable');
		const database = sqlite.database;
		let batchCalls = 0;
		let releaseBoth: () => void = () => undefined;
		const bothArrived = new Promise<void>((resolve) => {
			releaseBoth = resolve;
		});
		const wrapped: D1Database = {
			prepare: (query) => database.prepare(query),
			exec: (query) => database.exec(query),
			withSession: (constraintOrBookmark) =>
				database.withSession(constraintOrBookmark),
			dump: () => database.dump(),
			batch: async <T>(statements: D1PreparedStatement[]) => {
				batchCalls += 1;
				if (batchCalls === 2) releaseBoth();
				await bothArrived;
				return database.batch<T>(statements);
			},
		};
		const first = command();
		const firstPass = first.measurement.passes[0];
		if (!firstPass) throw new Error('missing pass fixture');
		const second = {
			...first,
			measurementDigest: 'd'.repeat(64),
			measurement: {
				...first.measurement,
				passes: [{ ...firstPass, durationMs: 101 }],
			},
		};
		const results = await Promise.allSettled([
			new CornerEvidenceAuthority(wrapped).commit(first),
			new CornerEvidenceAuthority(wrapped).commit(second),
		]);
		expect(
			results.filter((result) => result.status === 'fulfilled'),
		).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toEqual([
			expect.objectContaining({
				reason: new CornerEvidenceAuthorityError('STALE_AUTHORITY'),
			}),
		]);
		const [storedBatch] = await value.database
			.select()
			.from(cornerEvidenceBatch);
		const [storedPass] = await value.database.select().from(cornerPassEvidence);
		expect(storedBatch).toBeDefined();
		expect(storedPass).toMatchObject({
			batchMeasurementDigest: storedBatch?.measurementDigest,
			durationMs: storedBatch?.measurementDigest === 'c'.repeat(64) ? 100 : 101,
		});
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

	test.each([
		{
			batchCase: 'failure' as const,
			expected: new CornerEvidenceAuthorityError('RETRYABLE_INFRASTRUCTURE'),
		},
		{
			batchCase: 'no-op' as const,
			expected: new CornerEvidenceAuthorityError('STALE_AUTHORITY'),
		},
	])(
		'maps a D1 batch $batchCase without publishing partial evidence',
		async ({ batchCase, expected }) => {
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
			).rejects.toEqual(expected);
			expect(await value.database.select().from(cornerEvidenceBatch)).toEqual(
				[],
			);
		},
	);

	test.each(['raw-read-failure', 'known-stale-record'] as const)(
		'maps post-batch $case without trusting partial evidence',
		async (failureCase) => {
			const value = await seed();
			if (!sqlite) throw new Error('SQLite fixture unavailable');
			const database = sqlite.database;
			let batchAttempted = false;
			const wrapped: D1Database = {
				prepare: (query) => {
					if (
						failureCase === 'raw-read-failure' &&
						batchAttempted &&
						query.includes('corner_evidence_batch')
					)
						throw new Error('private D1 read failure');
					return database.prepare(query);
				},
				exec: (query) => database.exec(query),
				withSession: (constraintOrBookmark) =>
					database.withSession(constraintOrBookmark),
				dump: () => database.dump(),
				batch: async () => {
					batchAttempted = true;
					if (failureCase === 'known-stale-record')
						await value.database.insert(cornerEvidenceBatch).values({
							...batchValues(),
							measurementVersion: 'corner-evidence.v2',
						});
					throw new Error('private D1 batch failure');
				},
			};
			await expect(
				new CornerEvidenceAuthority(wrapped).commit(command()),
			).rejects.toEqual(
				new CornerEvidenceAuthorityError(
					failureCase === 'raw-read-failure'
						? 'RETRYABLE_INFRASTRUCTURE'
						: 'STALE_AUTHORITY',
				),
			);
		},
	);
});
