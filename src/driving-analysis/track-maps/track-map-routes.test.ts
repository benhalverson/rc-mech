import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	car,
	driveSession,
	owner,
	trackCorner,
	trackMapReferenceFrame,
	trackMapVersion,
} from '../../schema';
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
	vi.restoreAllMocks();
	sqlite?.close();
	sqlite = undefined;
});

const fixture = async (userId = 'owner-1') => {
	sqlite = createSqliteD1();
	sqlite.exec(migrations);
	const database = drizzle(sqlite.database);
	const createdAt = new Date('2026-08-17T00:00:00.000Z');
	await database.insert(owner).values([
		{
			id: 'owner-1',
			name: 'Owner',
			email: 'owner@example.com',
			emailVerified: true,
			createdAt,
			updatedAt: createdAt,
			timezone: 'UTC',
		},
		{
			id: 'user-1',
			name: 'User',
			email: 'user@example.com',
			emailVerified: true,
			createdAt,
			updatedAt: createdAt,
			timezone: 'UTC',
		},
	]);
	await database.insert(car).values({
		id: 'car-1',
		ownerId: 'owner-1',
		name: 'Buggy',
		createdAt: createdAt.toISOString(),
	});
	await database.insert(driveSession).values({
		id: 'drive-1',
		carId: 'car-1',
		startedAt: createdAt.toISOString(),
	});
	const value = createHonoFixture({ database: sqlite.database, userId });
	Object.assign(value.env, { OWNER_EMAIL: 'owner@example.com' });
	return value;
};

const json = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

const corner = (key = 'turn-1') => ({
	key,
	name: 'Turn 1',
	order: 1,
	entryGate: {
		start: { x: 0.22, y: 0.68 },
		end: { x: 0.35, y: 0.61 },
		direction: 'forward',
	},
	exitGate: {
		start: { x: 0.48, y: 0.44 },
		end: { x: 0.57, y: 0.52 },
		direction: 'forward',
	},
	cornerView: { x: 0.18, y: 0.35, width: 0.44, height: 0.38 },
});

const attachReferenceFrame = async (mapVersionId: string): Promise<void> => {
	if (!sqlite) throw new Error('SQLite fixture is unavailable');
	await drizzle(sqlite.database)
		.insert(trackMapReferenceFrame)
		.values({
			id: crypto.randomUUID(),
			mapVersionId,
			raceVideoId: '33333333-3333-4333-8333-333333333333',
			timestampMs: 1_000,
			objectKey: `track-map-reference-frames/${mapVersionId}/${crypto.randomUUID()}.jpg`,
			byteCount: 3,
			checksumSha256: 'a'.repeat(64),
			contentType: 'image/jpeg',
			createdBy: 'owner-1',
			createdAt: new Date('2026-08-17T00:00:00.000Z').toISOString(),
		});
};

describe('Track-map routes', () => {
	test('owner creates, edits, reopens, clones, renames, and retires draft layouts', async () => {
		const { request } = await fixture();
		expect((await request('/api/v1/track-layouts')).status).toBe(200);
		let response = await request(
			'/api/v1/track-layouts',
			json('POST', { name: 'Main track' }),
		);
		expect(response.status).toBe(201);
		const layout = ((await response.json()) as { trackLayout: { id: string } })
			.trackLayout;
		response = await request('/api/v1/track-layouts');
		expect(await response.json()).toMatchObject({
			canManage: true,
			trackLayouts: [{ id: layout.id, mapVersions: [] }],
		});
		response = await request(
			`/api/v1/track-layouts/${layout.id}/map-versions`,
			json('POST', {}),
		);
		expect(response.status).toBe(201);
		const first = (
			(await response.json()) as {
				trackMapVersion: {
					id: string;
					version: number;
					stateVersion: number;
				};
			}
		).trackMapVersion;
		expect(first.version).toBe(1);
		expect(first.stateVersion).toBe(1);
		response = await request(
			`/api/v1/track-map-versions/${first.id}`,
			json('PATCH', {
				expectedStateVersion: 1,
				corners: [corner(), { ...corner('turn-2'), name: 'Turn 2', order: 2 }],
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			trackMapVersion: { corners: expect.arrayContaining([corner()]) },
		});
		response = await request(
			`/api/v1/track-map-versions/${first.id}`,
			json('PATCH', { expectedStateVersion: 2, corners: [] }),
		);
		expect(await response.json()).toMatchObject({
			trackMapVersion: { corners: [] },
		});
		response = await request(
			`/api/v1/track-map-versions/${first.id}`,
			json('PATCH', { expectedStateVersion: 3, corners: [corner()] }),
		);
		expect(response.status).toBe(200);
		await attachReferenceFrame(first.id);
		response = await request(
			`/api/v1/track-map-versions/${first.id}/approve`,
			json('POST', { expectedStateVersion: 4 }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			trackMapVersion: {
				stateVersion: 5,
				status: 'approved',
				createdBy: 'owner-1',
				approvedBy: 'owner-1',
				approvedAt: expect.any(String),
			},
		});
		response = await request(`/api/v1/track-map-versions/${first.id}`);
		expect(response.status).toBe(200);
		response = await request(
			`/api/v1/track-layouts/${layout.id}/map-versions/${first.id}`,
		);
		expect(await response.json()).toMatchObject({
			trackMapVersion: { corners: expect.arrayContaining([corner()]) },
		});
		response = await request(
			`/api/v1/track-layouts/${layout.id}/map-versions`,
			json('POST', { sourceVersionId: first.id }),
		);
		expect(response.status).toBe(201);
		const second = (
			(await response.json()) as {
				trackMapVersion: {
					id: string;
					version: number;
					corners: unknown[];
				};
			}
		).trackMapVersion;
		expect(second).toMatchObject({
			version: 2,
			corners: expect.arrayContaining([corner()]),
		});
		response = await request(
			`/api/v1/track-layouts/${layout.id}`,
			json('PATCH', { name: 'Main track renovated' }),
		);
		expect(response.status).toBe(200);
		response = await request(`/api/v1/track-layouts/${layout.id}/retire`, {
			method: 'POST',
		});
		expect(response.status).toBe(200);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${first.id}`,
					json('PATCH', { expectedStateVersion: 5, corners: [corner()] }),
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${second.id}`,
					json('PATCH', { expectedStateVersion: 1, corners: [] }),
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					`/api/v1/track-layouts/${layout.id}`,
					json('PATCH', { name: 'Cannot rename' }),
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(`/api/v1/track-layouts/${layout.id}/retire`, {
					method: 'POST',
				})
			).status,
		).toBe(409);
		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		const userFixture = createHonoFixture({
			database: sqlite.database,
			userId: 'user-1',
		});
		Object.assign(userFixture.env, { OWNER_EMAIL: 'owner@example.com' });
		expect(
			(await userFixture.request(`/api/v1/track-map-versions/${first.id}`))
				.status,
		).toBe(404);
		const database = drizzle(sqlite.database);
		await expect(
			database
				.update(trackMapVersion)
				.set({ updatedAt: '2026-08-17T00:01:00.000Z' })
				.where(eq(trackMapVersion.id, first.id)),
		).rejects.toThrow();
		await expect(
			database.insert(trackMapVersion).values({
				id: '00000000-0000-4000-8000-000000000001',
				layoutId: layout.id,
				version: 3,
				status: 'draft',
				sourceVersionId: null,
				createdBy: 'owner-1',
				createdAt: '2026-08-17T00:01:00.000Z',
				updatedAt: '2026-08-17T00:01:00.000Z',
				approvedBy: null,
				approvedAt: null,
				retiredAt: null,
			}),
		).rejects.toThrow();
	});

	test('rejects malformed and degenerate draft geometry', async () => {
		const { request } = await fixture();
		const created = await request(
			'/api/v1/track-layouts',
			json('POST', { name: 'Geometry track' }),
		);
		const layoutId = ((await created.json()) as { trackLayout: { id: string } })
			.trackLayout.id;
		const version = await request(
			`/api/v1/track-layouts/${layoutId}/map-versions`,
			json('POST', {}),
		);
		const versionId = (
			(await version.json()) as { trackMapVersion: { id: string } }
		).trackMapVersion.id;
		const invalid = {
			...corner(),
			entryGate: { ...corner().entryGate, end: corner().entryGate.start },
		};
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}`,
					json('PATCH', { expectedStateVersion: 1, corners: [invalid] }),
				)
			).status,
		).toBe(400);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}`,
					json('PATCH', {
						expectedStateVersion: 1,
						corners: [{ ...corner(), key: 'bad key' }],
					}),
				)
			).status,
		).toBe(400);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}`,
					json('PATCH', {
						expectedStateVersion: 1,
						corners: [corner(), { ...corner(), key: 'turn-2', order: 1 }],
					}),
				)
			).status,
		).toBe(400);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}`,
					json('PATCH', {
						expectedStateVersion: 1,
						corners: [corner(), { ...corner(), order: 2 }],
					}),
				)
			).status,
		).toBe(400);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}`,
					json('PATCH', {
						expectedStateVersion: 1,
						corners: [
							{
								...corner(),
								cornerView: { x: 0.8, y: 0.8, width: 0.4, height: 0.4 },
							},
						],
					}),
				)
			).status,
		).toBe(400);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}`,
					json('PATCH', {
						expectedStateVersion: 1,
						corners: [
							{ ...corner(), cornerView: { ...corner().cornerView, width: 0 } },
						],
					}),
				)
			).status,
		).toBe(400);
	});

	test('fails closed for missing, conflicting, retired, and approved mutations', async () => {
		const { request } = await fixture();
		expect(
			(await request('/api/v1/track-layouts', json('POST', {}))).status,
		).toBe(400);
		let response = await request(
			'/api/v1/track-layouts',
			json('POST', { name: 'Conflict track' }),
		);
		const layoutId = (
			(await response.json()) as { trackLayout: { id: string } }
		).trackLayout.id;
		await request(
			'/api/v1/track-layouts',
			json('POST', { name: 'Other track' }),
		);
		expect(
			(
				await request(
					'/api/v1/track-layouts',
					json('POST', { name: 'Conflict track' }),
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					`/api/v1/track-layouts/${layoutId}`,
					json('PATCH', { name: 'Other track' }),
				)
			).status,
		).toBe(409);
		expect(
			(await request(`/api/v1/track-layouts/${layoutId}`, json('PATCH', {})))
				.status,
		).toBe(400);
		expect(
			(
				await request(
					'/api/v1/track-layouts/missing',
					json('PATCH', { name: 'Missing' }),
				)
			).status,
		).toBe(404);
		expect(
			(
				await request(
					`/api/v1/track-layouts/${layoutId}/map-versions`,
					json('POST', { sourceVersionId: 'not-a-uuid' }),
				)
			).status,
		).toBe(400);
		expect(
			(
				await request('/api/v1/track-layouts/missing/retire', {
					method: 'POST',
				})
			).status,
		).toBe(404);
		expect(
			(
				await request(
					'/api/v1/track-layouts/missing/map-versions',
					json('POST', {}),
				)
			).status,
		).toBe(404);
		expect(
			(
				await request(
					`/api/v1/track-layouts/${layoutId}/map-versions`,
					json('POST', {
						sourceVersionId: '00000000-0000-4000-8000-000000000099',
					}),
				)
			).status,
		).toBe(404);
		response = await request(
			`/api/v1/track-layouts/${layoutId}/map-versions`,
			json('POST', {}),
		);
		const versionId = (
			(await response.json()) as { trackMapVersion: { id: string } }
		).trackMapVersion.id;
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}/approve`,
					json('POST', { expectedStateVersion: 1 }),
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}/approve`,
					json('POST', {}),
				)
			).status,
		).toBe(400);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}`,
					json('PATCH', { expectedStateVersion: 1, corners: [corner()] }),
				)
			).status,
		).toBe(200);
		await attachReferenceFrame(versionId);
		expect(
			(
				await request(
					`/api/v1/track-layouts/${layoutId}/map-versions`,
					json('POST', { sourceVersionId: versionId }),
				)
			).status,
		).toBe(404);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}/retire`,
					json('POST', { expectedStateVersion: 2 }),
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					'/api/v1/track-map-versions/missing/approve',
					json('POST', { expectedStateVersion: 1 }),
				)
			).status,
		).toBe(404);
		expect(
			(
				await request(
					'/api/v1/track-map-versions/missing/retire',
					json('POST', { expectedStateVersion: 1 }),
				)
			).status,
		).toBe(404);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}/retire`,
					json('POST', {}),
				)
			).status,
		).toBe(400);
		expect(
			(await request(`/api/v1/track-layouts/${layoutId}/map-versions/wrong`))
				.status,
		).toBe(404);
		expect((await request('/api/v1/track-map-versions/missing')).status).toBe(
			404,
		);
		expect(
			(
				await request(
					'/api/v1/track-map-versions/missing',
					json('PATCH', { expectedStateVersion: 1, corners: [] }),
				)
			).status,
		).toBe(404);
		expect(
			(await request(`/api/v1/track-map-versions/${versionId}`)).status,
		).toBe(200);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}/approve`,
					json('POST', { expectedStateVersion: 2 }),
				)
			).status,
		).toBe(200);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}/approve`,
					json('POST', { expectedStateVersion: 3 }),
				)
			).status,
		).toBe(409);
		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		await expect(
			drizzle(sqlite.database)
				.delete(trackCorner)
				.where(eq(trackCorner.mapVersionId, versionId)),
		).rejects.toThrow();
		expect(
			await drizzle(sqlite.database)
				.select()
				.from(trackCorner)
				.where(eq(trackCorner.mapVersionId, versionId)),
		).toHaveLength(1);
		await expect(
			drizzle(sqlite.database)
				.update(trackMapVersion)
				.set({
					version: 99,
					status: 'retired',
					stateVersion: 4,
					retiredAt: '2026-08-17T00:02:00.000Z',
				})
				.where(eq(trackMapVersion.id, versionId)),
		).rejects.toThrow();
		await expect(
			drizzle(sqlite.database)
				.delete(trackMapVersion)
				.where(eq(trackMapVersion.id, versionId)),
		).rejects.toThrow();
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}`,
					json('PATCH', { expectedStateVersion: 3, corners: [] }),
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					`/api/v1/track-layouts/${layoutId}/map-versions`,
					json('POST', { sourceVersionId: versionId }),
				)
			).status,
		).toBe(201);
		sqlite.exec(`
			CREATE TRIGGER reject_next_track_map
			BEFORE INSERT ON track_map_version
			BEGIN
				SELECT RAISE(ABORT, 'Track-map versions must be the next draft for their layout');
			END;
		`);
		expect(
			(
				await request(
					`/api/v1/track-layouts/${layoutId}/map-versions`,
					json('POST', {}),
				)
			).status,
		).toBe(409);
		sqlite.exec('DROP TRIGGER reject_next_track_map;');
		sqlite.exec(`
			CREATE TRIGGER reject_next_track_map
			BEFORE INSERT ON track_map_version
			BEGIN
				SELECT RAISE(ABORT, 'simulated database outage');
			END;
		`);
		const errorLog = vi
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		expect(
			(
				await request(
					`/api/v1/track-layouts/${layoutId}/map-versions`,
					json('POST', {}),
				)
			).status,
		).toBe(500);
		expect(errorLog).toHaveBeenCalled();
		sqlite.exec('DROP TRIGGER reject_next_track_map;');
		await request(`/api/v1/track-layouts/${layoutId}/retire`, {
			method: 'POST',
		});
		expect(
			(
				await request(
					`/api/v1/track-layouts/${layoutId}/map-versions`,
					json('POST', {}),
				)
			).status,
		).toBe(404);
	});

	test('ordinary users see approved layout summaries but no drafts and cannot mutate', async () => {
		const ownerFixture = await fixture();
		const created = await ownerFixture.request(
			'/api/v1/track-layouts',
			json('POST', { name: 'Owner track' }),
		);
		const layoutId = ((await created.json()) as { trackLayout: { id: string } })
			.trackLayout.id;
		const draft = await ownerFixture.request(
			`/api/v1/track-layouts/${layoutId}/map-versions`,
			json('POST', {}),
		);
		const versionId = (
			(await draft.json()) as { trackMapVersion: { id: string } }
		).trackMapVersion.id;
		await ownerFixture.request(
			`/api/v1/track-map-versions/${versionId}`,
			json('PATCH', { expectedStateVersion: 1, corners: [corner()] }),
		);
		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		const userFixture = createHonoFixture({
			database: sqlite.database,
			userId: 'user-1',
		});
		Object.assign(userFixture.env, { OWNER_EMAIL: 'owner@example.com' });
		let response = await userFixture.request('/api/v1/track-layouts');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			canManage: false,
			trackLayouts: [],
		});
		expect(
			(await userFixture.request(`/api/v1/track-map-versions/${versionId}`))
				.status,
		).toBe(404);
		await attachReferenceFrame(versionId);
		expect(
			(
				await ownerFixture.request(
					`/api/v1/track-map-versions/${versionId}/approve`,
					json('POST', { expectedStateVersion: 2 }),
				)
			).status,
		).toBe(200);
		response = await userFixture.request('/api/v1/track-layouts');
		expect(await response.json()).toMatchObject({
			canManage: false,
			trackLayouts: [
				{ id: layoutId, mapVersions: [{ id: versionId, status: 'approved' }] },
			],
		});
		expect(
			(
				await userFixture.request(
					'/api/v1/track-layouts',
					json('POST', { name: 'Nope' }),
				)
			).status,
		).toBe(404);
		expect(
			(
				await userFixture.request(
					`/api/v1/track-layouts/${layoutId}/map-versions/${versionId}`,
				)
			).status,
		).toBe(200);
		expect(
			(await userFixture.request(`/api/v1/track-map-versions/${versionId}`))
				.status,
		).toBe(200);
		expect(
			(
				await userFixture.request(
					`/api/v1/track-layouts/${layoutId}`,
					json('PATCH', { name: 'Nope' }),
				)
			).status,
		).toBe(404);
		expect(
			(
				await userFixture.request(`/api/v1/track-layouts/${layoutId}/retire`, {
					method: 'POST',
				})
			).status,
		).toBe(404);
		expect(
			(
				await userFixture.request(
					`/api/v1/track-layouts/${layoutId}/map-versions`,
					json('POST', {}),
				)
			).status,
		).toBe(404);
		expect(
			(
				await userFixture.request(
					`/api/v1/track-map-versions/${versionId}`,
					json('PATCH', { expectedStateVersion: 3, corners: [] }),
				)
			).status,
		).toBe(404);
		for (const action of ['approve', 'retire']) {
			expect(
				(
					await userFixture.request(
						`/api/v1/track-map-versions/${versionId}/${action}`,
						json('POST', { expectedStateVersion: 3 }),
					)
				).status,
			).toBe(404);
		}
		expect(
			(
				await ownerFixture.request(
					`/api/v1/track-map-versions/${versionId}/retire`,
					json('POST', { expectedStateVersion: 3 }),
				)
			).status,
		).toBe(200);
		expect(
			await (await userFixture.request('/api/v1/track-layouts')).json(),
		).toEqual({ canManage: false, trackLayouts: [] });
		expect(
			(await userFixture.request(`/api/v1/track-map-versions/${versionId}`))
				.status,
		).toBe(404);
		expect(
			await drizzle(sqlite.database)
				.select()
				.from(trackMapVersion)
				.where(eq(trackMapVersion.id, versionId)),
		).toMatchObject([{ status: 'retired', stateVersion: 4 }]);
		expect(
			await drizzle(sqlite.database)
				.select()
				.from(trackCorner)
				.where(eq(trackCorner.mapVersionId, versionId)),
		).toHaveLength(1);
	});

	test('stale saves, approvals, and retirements conflict without partial writes', async () => {
		const { request } = await fixture();
		const created = await request(
			'/api/v1/track-layouts',
			json('POST', { name: 'Concurrent track' }),
		);
		const layoutId = ((await created.json()) as { trackLayout: { id: string } })
			.trackLayout.id;
		const draft = await request(
			`/api/v1/track-layouts/${layoutId}/map-versions`,
			json('POST', {}),
		);
		const versionId = (
			(await draft.json()) as { trackMapVersion: { id: string } }
		).trackMapVersion.id;
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}`,
					json('PATCH', { expectedStateVersion: 1, corners: [corner()] }),
				)
			).status,
		).toBe(200);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}`,
					json('PATCH', {
						expectedStateVersion: 1,
						corners: [{ ...corner(), name: 'Stale overwrite' }],
					}),
				)
			).status,
		).toBe(409);
		await attachReferenceFrame(versionId);
		expect(
			await (await request(`/api/v1/track-map-versions/${versionId}`)).json(),
		).toMatchObject({
			trackMapVersion: {
				stateVersion: 2,
				corners: [{ name: 'Turn 1' }],
			},
		});
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}/approve`,
					json('POST', { expectedStateVersion: 1 }),
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}/approve`,
					json('POST', { expectedStateVersion: 2 }),
				)
			).status,
		).toBe(200);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}/retire`,
					json('POST', { expectedStateVersion: 2 }),
				)
			).status,
		).toBe(409);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}/retire`,
					json('POST', { expectedStateVersion: 3 }),
				)
			).status,
		).toBe(200);
		expect(
			(
				await request(
					`/api/v1/track-map-versions/${versionId}/retire`,
					json('POST', { expectedStateVersion: 4 }),
				)
			).status,
		).toBe(409);
	});
});
