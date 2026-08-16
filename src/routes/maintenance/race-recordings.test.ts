import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	type AppDependencies,
	defaultAppDependencies,
} from '../../app-dependencies';
import {
	RaceRecordingAuthority,
	RaceRecordingAuthorityError,
} from '../../driving-analysis/race-recording/race-recording-authority';
import { car, driveSession, owner } from '../../schema';
import { createHonoFixture } from '../../testing/hono-fixture';
import { createSqliteD1, type SqliteD1Fixture } from '../../testing/sqlite-d1';

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
	vi.restoreAllMocks();
});

const integrationFixture = async () => {
	sqlite = createSqliteD1();
	sqlite.exec(migrations);
	const database = drizzle(sqlite.database);
	const createdAt = new Date('2026-08-16T20:00:00.000Z');
	await database.insert(owner).values({
		id: 'owner-1',
		name: 'Owner',
		email: 'owner@example.com',
		emailVerified: true,
		createdAt,
		updatedAt: createdAt,
		timezone: 'UTC',
	});
	await database.insert(car).values({
		id: 'car-1',
		ownerId: 'owner-1',
		name: 'Buggy',
		createdAt: createdAt.toISOString(),
	});
	await database.insert(driveSession).values([
		{
			id: 'drive-1',
			carId: 'car-1',
			startedAt: createdAt.toISOString(),
		},
		{
			id: 'drive-2',
			carId: 'car-1',
			startedAt: createdAt.toISOString(),
		},
	]);
	return createHonoFixture({ database: sqlite.database });
};

const json = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

describe('Race-recording routes', () => {
	test('uploads bounded parts, resumes authoritative progress, completes, and hides storage authority', async () => {
		const { request } = await integrationFixture();
		expect(
			(
				await request('/api/v1/cars/car-1/drives/drive-1/race-videos', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{',
				})
			).status,
		).toBe(400);
		expect(
			(await request('/api/v1/cars/car-1/drives/drive-1/race-videos', json({})))
				.status,
		).toBe(400);

		const createBody = {
			fileName: 'Race.mov',
			contentType: 'video/quicktime',
			sizeBytes: 3,
			requestId: '00000000-0000-4000-8000-000000000001',
		};
		expect(
			(
				await request(
					'/api/v1/cars/car-1/drives/drive-1/race-videos',
					json({ ...createBody, requestId: 'not-a-uuid' }),
				)
			).status,
		).toBe(400);
		let response = await request(
			'/api/v1/cars/car-1/drives/drive-1/race-videos',
			json(createBody),
		);
		expect(response.status).toBe(201);
		const created = (await response.json()) as {
			raceVideo: { id: string };
		};
		const recordingId = created.raceVideo.id;
		expect(JSON.stringify(created)).not.toMatch(
			/objectKey|uploadId|credential/,
		);

		response = await request(
			'/api/v1/cars/car-1/drives/drive-1/race-videos',
			json(createBody),
		);
		expect(response.status).toBe(200);
		response = await request('/api/v1/cars/car-1/race-videos');
		expect(await response.json()).toMatchObject({
			raceVideos: [{ id: recordingId, status: 'uploading', uploadedBytes: 0 }],
		});
		response = await request(`/api/v1/race-videos/${recordingId}`);
		expect(await response.json()).toMatchObject({
			raceVideo: { id: recordingId },
		});

		const partPath = `/api/v1/race-videos/${recordingId}/upload-parts/1`;
		expect((await request(partPath, { method: 'PUT' })).status).toBe(400);
		response = await request(partPath, {
			method: 'PUT',
			headers: {
				'content-length': '3',
				'x-transfer-request-id': 'recording-part-1',
			},
			body: Uint8Array.of(1, 2, 3),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			raceVideo: { uploadedBytes: 3 },
		});

		response = await request(`/api/v1/race-videos/${recordingId}/complete`, {
			method: 'POST',
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			raceVideo: { status: 'validating', uploadedBytes: 3 },
		});
	});

	test('cancels idempotently and never exposes another owner upload', async () => {
		const { request } = await integrationFixture();
		const response = await request(
			'/api/v1/cars/car-1/drives/drive-2/race-videos',
			json({
				fileName: 'Race.mp4',
				contentType: 'video/mp4',
				sizeBytes: 2,
				requestId: '00000000-0000-4000-8000-000000000002',
			}),
		);
		const recordingId = (
			(await response.json()) as { raceVideo: { id: string } }
		).raceVideo.id;
		const path = `/api/v1/race-videos/${recordingId}`;
		expect((await request(path, { method: 'DELETE' })).status).toBe(204);
		expect((await request(path, { method: 'DELETE' })).status).toBe(204);

		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		const foreign = createHonoFixture({
			database: sqlite.database,
			userId: 'another-owner',
		});
		expect(
			(await foreign.request('/api/v1/cars/car-1/race-videos')).status,
		).toBe(404);
	});

	test.each([
		['INVALID_PART', 400],
		['NOT_FOUND', 404],
		['CONFLICT', 409],
		['EXPIRED', 410],
		['QUOTA_EXCEEDED', 429],
		['RATE_LIMITED', 429],
		['STORAGE_UNAVAILABLE', 503],
	] as const)('maps safe %s authority failures to %i', async (code, status) => {
		const list = vi
			.fn()
			.mockRejectedValue(
				new RaceRecordingAuthorityError(code, 'Safe upload failure'),
			);
		const fake = { list } as unknown as RaceRecordingAuthority;
		const { request } = createHonoFixture({
			raceRecordingAuthority: (() =>
				fake) satisfies AppDependencies['raceRecordingAuthority'],
		});
		const response = await request('/api/v1/cars/car-1/race-videos');
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ error: 'Safe upload failure' });
	});

	test('routes complete and cancel through the authenticated identity', async () => {
		const get = vi.fn().mockResolvedValue({ id: 'recording-1' });
		const complete = vi.fn().mockResolvedValue({ id: 'recording-1' });
		const remove = vi.fn().mockResolvedValue(undefined);
		const fake = { get, complete, remove } as unknown as RaceRecordingAuthority;
		const { request } = createHonoFixture({
			raceRecordingAuthority: () => fake,
		});
		const base = '/api/v1/race-videos/recording-1';
		expect((await request(base)).status).toBe(200);
		expect((await request(`${base}/complete`, { method: 'POST' })).status).toBe(
			200,
		);
		expect((await request(base, { method: 'DELETE' })).status).toBe(204);
		expect(complete).toHaveBeenCalledWith({
			ownerId: 'owner-1',
			recordingId: 'recording-1',
		});
		expect(remove).toHaveBeenCalledWith(
			expect.objectContaining({
				ownerId: 'owner-1',
			}),
		);
	});

	test('constructs the production authority and preserves unexpected failures', async () => {
		const production = createHonoFixture();
		expect(
			defaultAppDependencies.raceRecordingAuthority(production.env),
		).toBeInstanceOf(RaceRecordingAuthority);

		const fake = {
			list: vi.fn().mockRejectedValue(new Error('unexpected')),
		} as unknown as RaceRecordingAuthority;
		const failure = createHonoFixture({ raceRecordingAuthority: () => fake });
		const response = await failure.request('/api/v1/cars/car-1/race-videos');
		expect(response.status).toBe(500);
	});
});
