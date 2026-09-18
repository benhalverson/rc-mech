import { readdirSync, readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { owner } from '../schema';
import { createHonoFixture } from '../testing/hono-fixture';
import { createSqliteD1, type SqliteD1Fixture } from '../testing/sqlite-d1';

let sqlite: SqliteD1Fixture;
const path = '/api/v1/feature-flags/driving-analysis';
const fixture = (userId = 'owner-1', authenticated = true) => {
	const value = createHonoFixture({
		userId,
		authenticated,
		database: sqlite.database,
	});
	Object.assign(value.env, { OWNER_EMAIL: ' OWNER@example.com ' });
	return value;
};
const put = (body: unknown): RequestInit => ({
	method: 'PUT',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(body),
});

beforeEach(async () => {
	sqlite = createSqliteD1();
	for (const name of readdirSync('migrations')
		.filter((name) => name.endsWith('.sql'))
		.sort())
		sqlite.exec(readFileSync(`migrations/${name}`, 'utf8'));
	const date = new Date();
	await drizzle(sqlite.database)
		.insert(owner)
		.values([
			{
				id: 'owner-1',
				name: 'Owner',
				email: 'owner@example.com',
				emailVerified: true,
				createdAt: date,
				updatedAt: date,
			},
			{
				id: 'user-1',
				name: 'User',
				email: 'user@example.com',
				emailVerified: true,
				createdAt: date,
				updatedAt: date,
			},
		]);
});
afterEach(() => {
	sqlite.close();
	vi.restoreAllMocks();
});

describe('Driving analysis flag requests', () => {
	it('defaults off and persists both values across independent requests', async () => {
		const first = fixture();
		const response = await first.request(path, {});
		expect(await response.json()).toEqual({ enabled: false });
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		for (const enabled of [true, false]) {
			const saved = await first.request(path, put({ enabled }));
			expect(saved.status).toBe(200);
			expect(await saved.json()).toEqual({ enabled });
			const next = fixture('user-1');
			expect(await (await next.request(path, {})).json()).toEqual({ enabled });
		}
	});
	it.each(['user-1', 'missing-user'])(
		'denies writes from %s and reports identity',
		async (id) => {
			const value = fixture(id);
			expect(
				await (await value.request('/api/v1/feature-flags/owner', {})).json(),
			).toEqual({ isOwner: false });
			expect((await value.request(path, put({ enabled: true }))).status).toBe(
				403,
			);
			expect(await (await value.request(path, {})).json()).toEqual({
				enabled: false,
			});
		},
	);
	it('rejects unauthenticated reads and writes', async () => {
		const value = fixture('owner-1', false);
		for (const [url, options] of [
			[path, {}],
			[path, put({ enabled: true })],
			['/api/v1/feature-flags/owner', {}],
		] as const) {
			expect((await value.request(url, options)).status).toBe(401);
		}
	});
	it.each([
		{},
		{ enabled: 'true' },
		{ enabled: 1 },
		{ enabled: null },
		{ enabled: true, extra: true },
	])('rejects invalid values %j', async (body) => {
		const value = fixture();
		expect((await value.request(path, put(body))).status).toBe(400);
	});
	it('rejects malformed JSON', async () => {
		const value = fixture();
		expect(
			(await value.request(path, { method: 'PUT', body: '{' })).status,
		).toBe(400);
	});
	it('keeps verified Owner identity readable when flag storage fails', async () => {
		const value = fixture();
		sqlite.exec('DROP TABLE driving_analysis_flag');
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect((await value.request(path, {})).status).toBe(500);
		expect(
			await (await value.request('/api/v1/feature-flags/owner', {})).json(),
		).toEqual({ isOwner: true });
		expect((await value.request(path, put({ enabled: true }))).status).toBe(
			500,
		);
	});
	it('requires configured ownership', async () => {
		const value = fixture();
		Object.assign(value.env, { OWNER_EMAIL: '' });
		expect((await value.request(path, put({ enabled: true }))).status).toBe(
			403,
		);
	});
});
