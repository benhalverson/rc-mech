import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	inferenceProfileFixture,
	RUN_ID,
} from '../../testing/driving-analysis-tracking-fixtures';
import { MockR2Controller } from '../../testing/hono-fixture';
import {
	CORRELATION_ID,
	MANIFEST_SHA,
	MEDIA_SHA,
	PREPARED_MEDIA_ID,
	prepareAcceptedFixture,
	trackingRunInputFixture,
} from '../../testing/prepared-track-view-fixtures';
import { createSqliteD1, type SqliteD1Fixture } from '../../testing/sqlite-d1';
import { PreparedTrackViewAuthority } from './prepared-track-view-authority';
import {
	type PreparedTrackViewStore,
	R2PreparedTrackViewStore,
} from './r2-prepared-track-view-store';
import {
	type TrackViewMediaPreparationCommand,
	TrackViewPreparation,
	TrackViewPreparationError,
} from './track-view-preparation';
import { TrackingAuthority } from './tracking-authority';
import { digestTrackingRunInput } from './tracking-run-input';

const OWNER_ID = 'owner-1';
const NOW = new Date('2026-08-16T20:00:00.000Z');
const TERMINAL_AT = new Date('2026-08-17T20:01:00.000Z');
const CLEANUP_AT = new Date('2026-08-18T20:01:00.000Z');
const migrations = [
	'0019_tracking_authority.sql',
	'0020_immutable_track_view.sql',
]
	.map((name) =>
		readFileSync(
			resolve(
				dirname(fileURLToPath(import.meta.url)),
				'../../../migrations',
				name,
			),
			'utf8',
		),
	)
	.join('\n');

type MediaHandler = (
	command: TrackViewMediaPreparationCommand,
	media: MockR2Controller,
	inputDigest: string,
) => Promise<unknown>;

let sqlite: SqliteD1Fixture | undefined;

afterEach(() => {
	sqlite?.close();
	sqlite = undefined;
});

const seedPreparedObjects = async (
	media: MockR2Controller,
	command: TrackViewMediaPreparationCommand,
	options: {
		mediaBytes?: number;
		mediaChecksum?: string;
		mediaType?: string;
		manifest?: boolean;
		manifestEncoding?: string;
	} = {},
) => {
	await media.bucket.put(
		command.output.mediaObjectKey,
		'm'.repeat(options.mediaBytes ?? 14),
		{
			httpMetadata: { contentType: options.mediaType ?? 'video/mp4' },
			customMetadata: { sha256: options.mediaChecksum ?? MEDIA_SHA },
		},
	);
	if (options.manifest !== false)
		await media.bucket.put(
			command.output.frameManifestObjectKey,
			'f'.repeat(15),
			{
				httpMetadata: {
					contentType: 'application/vnd.rc-mech.prepared-frame-manifest+json',
					contentEncoding: options.manifestEncoding ?? 'gzip',
				},
				customMetadata: { sha256: MANIFEST_SHA },
			},
		);
};

const acceptedResponse = (
	command: TrackViewMediaPreparationCommand,
	inputDigest: string,
) =>
	prepareAcceptedFixture(
		inputDigest,
		command.request.preparedMediaId,
		command.request.correlationId,
	);

const preparationFixture = async (
	handler: MediaHandler,
	storeFactory: (media: MockR2Controller) => PreparedTrackViewStore = (media) =>
		new R2PreparedTrackViewStore(media.bucket),
	ids: readonly [string, string] = [PREPARED_MEDIA_ID, CORRELATION_ID],
) => {
	sqlite = createSqliteD1();
	sqlite.exec(migrations);
	const tracking = new TrackingAuthority(sqlite.database);
	const authority = new PreparedTrackViewAuthority(sqlite.database);
	const input = trackingRunInputFixture();
	const inputDigest = await digestTrackingRunInput(input);
	await tracking.createRun({
		runId: RUN_ID,
		analysisId: 'analysis-1',
		ownerId: OWNER_ID,
		sequence: 1,
		workflowId: 'workflow-1',
		profile: inferenceProfileFixture(),
		inputDigest,
		createdAt: NOW.toISOString(),
	});
	await authority.pinRunInput({
		ownerId: OWNER_ID,
		input,
		createdAt: NOW.toISOString(),
	});
	const analysisMedia = new MockR2Controller();
	const calls: TrackViewMediaPreparationCommand[] = [];
	const media = {
		prepare: async (command: TrackViewMediaPreparationCommand) => {
			calls.push(command);
			return handler(command, analysisMedia, inputDigest);
		},
	};
	const store = storeFactory(analysisMedia);
	let idIndex = 0;
	const preparation = new TrackViewPreparation({
		authority,
		media,
		store,
		now: () => NOW,
		id: () => ids[idIndex++ % ids.length] ?? PREPARED_MEDIA_ID,
	});
	return {
		analysisMedia,
		authority,
		calls,
		input,
		inputDigest,
		mediaPort: media,
		preparation,
		store,
		tracking,
	};
};

const expectPreparationError = async (
	promise: Promise<unknown>,
	code: TrackViewPreparationError['code'],
) => {
	await expect(promise).rejects.toMatchObject({
		name: 'TrackViewPreparationError',
		code,
	});
};

describe('TrackViewPreparation', () => {
	test('publishes and replays one verified private Track view without exposing its keys', async () => {
		const value = await preparationFixture(
			async (command, media, inputDigest) => {
				await seedPreparedObjects(media, command);
				return acceptedResponse(command, inputDigest);
			},
		);
		const result = await value.preparation.prepare(OWNER_ID, RUN_ID);
		expect(result).toEqual({
			runId: RUN_ID,
			prepared: prepareAcceptedFixture(value.inputDigest).prepared,
		});
		expect(JSON.stringify(result)).not.toContain('race-videos/');
		expect(JSON.stringify(result)).not.toContain('prepared/');
		expect(value.calls).toHaveLength(1);
		expect(value.calls[0]).toMatchObject({
			source: {
				objectKey: value.input.sourceObjectKey,
				byteCount: value.input.sourceByteCount,
				checksumSha256: value.input.sourceChecksumSha256,
			},
			request: {
				caseId: RUN_ID,
				input: { stagedMediaId: value.input.raceVideoId },
			},
		});
		expect(JSON.stringify(value.calls[0]?.request)).not.toContain(
			value.input.sourceObjectKey,
		);

		expect(await value.preparation.prepare(OWNER_ID, RUN_ID)).toEqual(result);
		expect(value.calls).toHaveLength(1);
	});

	test('retries a lost preparation response with the same immutable request and objects', async () => {
		let attempts = 0;
		const value = await preparationFixture(
			async (command, media, inputDigest) => {
				await seedPreparedObjects(media, command);
				attempts += 1;
				if (attempts === 1) throw new Error('lost response');
				return acceptedResponse(command, inputDigest);
			},
			(media) => new R2PreparedTrackViewStore(media.bucket),
			[PREPARED_MEDIA_ID, CORRELATION_ID],
		);
		const firstRequest = value.preparation.prepare(OWNER_ID, RUN_ID);
		await expectPreparationError(firstRequest, 'PREPARATION_REJECTED');
		const result = await value.preparation.prepare(OWNER_ID, RUN_ID);

		expect(value.calls).toHaveLength(2);
		expect(value.calls[1]).toEqual(value.calls[0]);
		expect(result.prepared.preparedMediaId).toBe(PREPARED_MEDIA_ID);
		expect(attempts).toBe(2);
	});

	test('uses Worker time and UUID capabilities when callers do not override them', async () => {
		const value = await preparationFixture(
			async (command, media, inputDigest) => {
				await seedPreparedObjects(media, command);
				return acceptedResponse(command, inputDigest);
			},
		);
		const preparation = new TrackViewPreparation({
			authority: value.authority,
			media: value.mediaPort,
			store: value.store,
		});
		const result = await preparation.prepare(OWNER_ID, RUN_ID);
		expect(result.prepared.preparedMediaId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	test('fails closed on accepted-cache loss without recomputing or relinking', async () => {
		const value = await preparationFixture(
			async (command, media, inputDigest) => {
				await seedPreparedObjects(media, command);
				return acceptedResponse(command, inputDigest);
			},
		);
		await value.preparation.prepare(OWNER_ID, RUN_ID);
		await value.analysisMedia.bucket.delete(
			`prepared/${PREPARED_MEDIA_ID}/track-view.mp4`,
		);
		await expectPreparationError(
			value.preparation.prepare(OWNER_ID, RUN_ID),
			'CACHE_LOST',
		);
		expect(value.calls).toHaveLength(1);
	});

	test.each([
		{
			name: 'safe rejection',
			code: 'PREPARATION_REJECTED' as const,
			response: {
				contractVersion: 'subject-tracking.v1',
				correlationId: CORRELATION_ID,
				outcome: 'rejected',
				caseId: RUN_ID,
				error: {
					code: 'PREPARATION_FAILED',
					stage: 'prepare',
					message: 'Race window preparation failed safely',
				},
			},
		},
		{
			name: 'invalid response',
			code: 'INVALID_RESPONSE' as const,
			response: { outcome: 'accepted', originalObjectKey: 'leak' },
		},
	])('cleans partial output after a $name', async ({ code, response }) => {
		const value = await preparationFixture(async (command, media) => {
			await media.bucket.put(command.output.mediaObjectKey, 'partial');
			return response;
		});
		await expectPreparationError(
			value.preparation.prepare(OWNER_ID, RUN_ID),
			code,
		);
		expect(value.analysisMedia.objects.size).toBe(0);
	});

	test('sanitizes thrown media failures and surfaces failed cleanup', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const failed = await preparationFixture(async (command, media) => {
			await media.bucket.put(command.output.mediaObjectKey, 'partial');
			throw new Error('secret source path');
		});
		await expectPreparationError(
			failed.preparation.prepare(OWNER_ID, RUN_ID),
			'PREPARATION_REJECTED',
		);
		expect(failed.analysisMedia.objects.size).toBe(0);
		expect(JSON.parse(log.mock.calls[0]?.[0]?.toString() ?? '')).toMatchObject({
			event: 'track_view_preparation',
			outcome: 'failed',
			phase: 'prepare',
			correlationId: CORRELATION_ID,
			caseId: RUN_ID,
			stagedMediaId: failed.input.raceVideoId,
			preparedMediaId: PREPARED_MEDIA_ID,
			errorName: 'Error',
			errorMessage: 'secret source path',
		});
		log.mockRestore();

		sqlite?.close();
		sqlite = undefined;
		const cleanupFailed = await preparationFixture(
			async () => {
				throw new Error('media failed');
			},
			() => ({
				head: async () => null,
				delete: async () => {
					throw new Error('R2 unavailable');
				},
			}),
		);
		await expectPreparationError(
			cleanupFailed.preparation.prepare(OWNER_ID, RUN_ID),
			'CLEANUP_FAILED',
		);
	});

	test.each([
		{
			name: 'an Error without a stack',
			thrownValue: (() => {
				const error = new Error('stackless media failure');
				Object.defineProperty(error, 'stack', { value: undefined });
				return error;
			})(),
			errorName: 'Error',
			errorMessage: 'stackless media failure',
		},
		{
			name: 'a non-Error value',
			thrownValue: 'plain media failure',
			errorName: 'unknown',
			errorMessage: 'plain media failure',
		},
		{
			name: 'null',
			thrownValue: null,
			errorName: 'unknown',
			errorMessage: 'unknown',
		},
		{
			name: 'undefined',
			thrownValue: undefined,
			errorName: 'unknown',
			errorMessage: 'unknown',
		},
	])(
		'logs safe details for $name media failures',
		async ({ thrownValue, errorName, errorMessage }) => {
			const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
			const value = await preparationFixture(async () => {
				throw thrownValue;
			});
			await expectPreparationError(
				value.preparation.prepare(OWNER_ID, RUN_ID),
				'PREPARATION_REJECTED',
			);
			const entry = JSON.parse(log.mock.calls[0]?.[0]?.toString() ?? '');
			expect(entry).toMatchObject({
				event: 'track_view_preparation',
				outcome: 'failed',
				phase: 'prepare',
				errorName,
				errorMessage,
			});
			expect(entry).not.toHaveProperty('errorStack');
			expect(JSON.stringify(entry)).not.toContain('race-videos/');
			log.mockRestore();
		},
	);

	test('cleans output whose descriptor does not match immutable input', async () => {
		const value = await preparationFixture(
			async (command, media, inputDigest) => {
				await seedPreparedObjects(media, command);
				const response = acceptedResponse(command, inputDigest);
				if (response.outcome !== 'accepted')
					throw new Error('fixture mismatch');
				return {
					...response,
					prepared: { ...response.prepared, sourceByteCount: 101 },
				};
			},
		);
		await expectPreparationError(
			value.preparation.prepare(OWNER_ID, RUN_ID),
			'ARTIFACT_MISMATCH',
		);
		expect(value.analysisMedia.objects.size).toBe(0);
	});

	test.each([
		{ name: 'missing manifest', options: { manifest: false } },
		{ name: 'wrong media size', options: { mediaBytes: 13 } },
		{ name: 'wrong checksum', options: { mediaChecksum: 'f'.repeat(64) } },
		{ name: 'wrong content type', options: { mediaType: 'video/webm' } },
		{ name: 'wrong encoding', options: { manifestEncoding: 'br' } },
	])('cleans $name output before D1 acceptance', async ({ options }) => {
		const value = await preparationFixture(
			async (command, media, inputDigest) => {
				await seedPreparedObjects(media, command, options);
				return acceptedResponse(command, inputDigest);
			},
		);
		await expectPreparationError(
			value.preparation.prepare(OWNER_ID, RUN_ID),
			'ARTIFACT_MISMATCH',
		);
		expect(value.analysisMedia.objects.size).toBe(0);
	});

	test('cleans its unique candidate when the run becomes stale after preparation', async () => {
		let tracking: TrackingAuthority | undefined;
		const value = await preparationFixture(
			async (command, media, inputDigest) => {
				await seedPreparedObjects(media, command);
				await tracking?.fenceRun({
					ownerId: OWNER_ID,
					runId: RUN_ID,
					expectedVersion: 1,
					status: 'cancelled',
					completedAt: TERMINAL_AT.toISOString(),
				});
				return acceptedResponse(command, inputDigest);
			},
		);
		tracking = value.tracking;
		await expect(
			value.preparation.prepare(OWNER_ID, RUN_ID),
		).rejects.toMatchObject({ code: 'STALE_AUTHORITY' });
		expect(value.analysisMedia.objects.size).toBe(0);
	});

	test('never deletes a candidate that D1 committed before a post-commit failure', async () => {
		const value = await preparationFixture(
			async (command, media, inputDigest) => {
				await seedPreparedObjects(media, command);
				return acceptedResponse(command, inputDigest);
			},
		);
		const accept = value.authority.acceptPreparedTrackView.bind(
			value.authority,
		);
		value.authority.acceptPreparedTrackView = async (command) => {
			await accept(command);
			throw new Error('post-commit read failed');
		};
		await expect(value.preparation.prepare(OWNER_ID, RUN_ID)).rejects.toThrow(
			'post-commit read failed',
		);
		expect(value.analysisMedia.objects.size).toBe(2);
		expect(
			await value.authority.isAcceptedCandidate(
				OWNER_ID,
				RUN_ID,
				PREPARED_MEDIA_ID,
			),
		).toBe(true);
	});

	test('leaves a candidate untouched when D1 cannot prove it is unaccepted', async () => {
		const value = await preparationFixture(
			async (command, media, inputDigest) => {
				await seedPreparedObjects(media, command);
				return acceptedResponse(command, inputDigest);
			},
		);
		value.authority.acceptPreparedTrackView = async () => {
			throw new Error('D1 write result unavailable');
		};
		value.authority.isAcceptedCandidate = async () => {
			throw new Error('D1 read unavailable');
		};
		await expect(value.preparation.prepare(OWNER_ID, RUN_ID)).rejects.toThrow(
			'D1 write result unavailable',
		);
		expect(value.analysisMedia.objects.size).toBe(2);
	});

	test('deletes only due media for a terminal run and makes retries idempotent', async () => {
		const value = await preparationFixture(
			async (command, media, inputDigest) => {
				await seedPreparedObjects(media, command);
				return acceptedResponse(command, inputDigest);
			},
		);
		await value.preparation.prepare(OWNER_ID, RUN_ID);
		expect(await value.preparation.cleanupDue(CLEANUP_AT)).toBe(0);
		await value.tracking.fenceRun({
			ownerId: OWNER_ID,
			runId: RUN_ID,
			expectedVersion: 1,
			status: 'failed',
			completedAt: TERMINAL_AT.toISOString(),
		});
		expect(
			await value.preparation.cleanupDue(new Date('2026-08-18T20:00:59.999Z')),
		).toBe(0);
		expect(await value.preparation.cleanupDue(CLEANUP_AT)).toBe(1);
		expect(value.analysisMedia.objects.size).toBe(0);
		expect(await value.preparation.cleanupDue(CLEANUP_AT)).toBe(0);
	});
});
