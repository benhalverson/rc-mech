import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	createHonoFixture,
	type MockD1Controller,
} from './testing/hono-fixture';

const invite = (o: Record<string, unknown> = {}) => ({
	id: 'invite-1',
	code: 'RACE-2026',
	creatorId: 'owner-1',
	slot: 1,
	status: 'available',
	reservedEmail: null,
	reservedUntil: null,
	redeemedEmail: null,
	redeemedUserId: null,
	reservedAt: null,
	redeemedAt: null,
	revokedAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	...o,
});
const json = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});
let active: MockD1Controller | undefined;
const fixture = (options: Parameters<typeof createHonoFixture>[0] = true) => {
	const value = createHonoFixture(options);
	active = value.d1;
	return value;
};
afterEach(() => {
	active?.expectConsumed();
	active = undefined;
	vi.restoreAllMocks();
});

describe('Worker composition and auth routes', () => {
	test('redirects the short docs URL and applies allowed CORS', async () => {
		const { request } = fixture();
		const docs = await request('/docs');
		expect(docs.status).toBe(302);
		expect(docs.headers.get('location')).toContain('/api/docs');
		const health = await request('/api/v1/health', {
			headers: { Origin: 'http://localhost:4200' },
		});
		expect(health.headers.get('access-control-allow-origin')).toBe(
			'http://localhost:4200',
		);
	});

	test('uses neutral registration responses when rate-limit storage is unavailable', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'error', error: new Error('migration pending') });
		const response = await request(
			'/api/auth/register',
			json({ email: 'bad' }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: true });
	});

	test('starts a fresh registration rate-limit window', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: null }, { kind: 'run' });
		const response = await request(
			'/api/auth/register',
			json({ email: 'bad' }),
		);
		expect(response.status).toBe(200);
	});

	test('rate limits registration with generic retry guidance', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{
				kind: 'first',
				value: {
					key: 'registration:unknown',
					windowStartedAt: Date.now(),
					count: 8,
				},
			},
			{ kind: 'first', value: { count: 9 } },
		);
		const response = await request(
			'/api/auth/register',
			json({ email: 'user@example.com', inviteCode: 'RACE-2026' }),
		);
		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('60');
	});

	test('rate limits using the attempted count when an update loses its row', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{
				kind: 'first',
				value: {
					key: 'registration:unknown',
					windowStartedAt: Date.now(),
					count: 8,
				},
			},
			{ kind: 'first', value: null },
		);
		expect((await request('/api/auth/register', json({}))).status).toBe(429);
	});

	test('rate limits magic-link requests with the same generic response', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{
				kind: 'first',
				value: {
					key: 'magic-link:unknown',
					windowStartedAt: Date.now(),
					count: 8,
				},
			},
			{ kind: 'first', value: { count: 9 } },
		);
		expect(
			(
				await request(
					'/api/auth/sign-in/magic-link',
					json({ email: 'user@example.com' }),
				)
			).status,
		).toBe(429);
	});

	test('keeps malformed JSON and invalid invite codes neutral', async () => {
		for (const init of [
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{',
			},
			json({ email: 'user@example.com', inviteCode: 'root' }),
		]) {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: null }, { kind: 'run' });
			expect((await request('/api/auth/register', init)).status).toBe(200);
			d1.expectConsumed();
			active = undefined;
		}
	});

	test.each([
		[
			'existing owner',
			[{ kind: 'first', value: { id: 'owner-1' } }],
			{ status: true },
		],
		[
			'missing invite',
			[
				{ kind: 'first', value: null },
				{ kind: 'run' },
				{ kind: 'first', value: null },
			],
			{ status: true },
		],
	] as const)(
		'keeps registration neutral for %s',
		async (_case, steps, expected) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: null }, { kind: 'run' });
			for (const step of steps) d1.queue(step);
			const response = await request(
				'/api/auth/register',
				json({ email: ' User@Example.com ', inviteCode: 'race-2026' }),
			);
			expect(await response.json()).toEqual(expected);
		},
	);

	test.each([
		['success', async () => Response.json({ status: true }), 200, []],
		[
			'downstream rejection',
			async () => new Response('bad', { status: 400 }),
			200,
			[{ kind: 'run' }],
		],
		[
			'downstream exception',
			async () => {
				throw new Error('auth failed');
			},
			200,
			[{ kind: 'run' }],
		],
	] as const)(
		'reserves registration then handles %s',
		async (_case, handleAuth, status, cleanup) => {
			const { d1, request } = fixture({ handleAuth });
			d1.queue(
				{ kind: 'first', value: null },
				{ kind: 'run' },
				{ kind: 'first', value: null },
				{ kind: 'run' },
				{ kind: 'first', value: invite() },
				{ kind: 'all', rows: [{ id: 'invite-1' }] },
				...cleanup,
			);
			const response = await request(
				'/api/auth/register',
				json({
					email: 'User@Example.com',
					inviteCode: 'race-2026',
					callbackURL: '/garage',
				}),
			);
			expect(response.status).toBe(status);
		},
	);

	test('keeps registration neutral when reservation loses a race', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{ kind: 'first', value: invite() },
			{ kind: 'all', rows: [] },
		);
		expect(
			(
				await request(
					'/api/auth/register',
					json({ email: 'user@example.com', inviteCode: 'race-2026' }),
				)
			).status,
		).toBe(200);
	});

	test('uses the default registration callback URL', async () => {
		let delegated = '';
		const { d1, request } = fixture({
			handleAuth: async (_env, delegatedRequest) => {
				delegated = await delegatedRequest.text();
				return Response.json({ status: true });
			},
		});
		d1.queue(
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{ kind: 'first', value: invite() },
			{ kind: 'all', rows: [{ id: 'invite-1' }] },
		);
		expect(
			(
				await request(
					'/api/auth/register',
					json({ email: 'user@example.com', inviteCode: 'race-2026' }),
				)
			).status,
		).toBe(200);
		expect(delegated).toContain('"callbackURL":"/sign-in"');
	});

	test('returns neutral magic-link response for an unknown local user', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{ kind: 'first', value: null },
		);
		const response = await request(
			'/api/auth/sign-in/magic-link',
			json({ email: 'unknown@example.com' }),
		);
		expect(await response.json()).toEqual({ status: true });
	});

	test('normalizes a known user before delegating magic-link auth', async () => {
		let delegated = '';
		const { d1, request } = fixture({
			handleAuth: async (_env, req) => {
				delegated = await req.text();
				return Response.json({ ok: true });
			},
		});
		d1.queue(
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{ kind: 'first', value: { id: 'owner-1' } },
		);
		const response = await request(
			'/api/auth/sign-in/magic-link',
			json({ email: ' User@Example.com ' }),
		);
		expect(response.status).toBe(200);
		expect(delegated).toContain('user@example.com');
	});

	test('rejects magic-link delivery when production email configuration is absent', async () => {
		const { d1, env, request } = fixture();
		Object.assign(env, { ENVIRONMENT: 'production' });
		d1.queue({ kind: 'first', value: null }, { kind: 'run' });
		expect(
			(
				await request(
					'/api/auth/sign-in/magic-link',
					json({ email: 'user@example.com' }),
				)
			).status,
		).toBe(503);
	});

	test('checks production email after validating the application URL', async () => {
		const { d1, env, request } = fixture();
		Object.assign(env, {
			ENVIRONMENT: 'production',
			APP_URL: 'https://chassisnotes.com',
			OWNER_EMAIL: 'owner@chassisnotes.com',
			EMAIL_FROM: 'RC Mech <noreply@chassisnotes.com>',
			EMAIL: undefined,
		});
		d1.queue({ kind: 'first', value: null }, { kind: 'run' });
		expect(
			(
				await request(
					'/api/auth/sign-in/magic-link',
					json({ email: 'user@example.com' }),
				)
			).status,
		).toBe(503);
	});

	test('delegates malformed and non-magic auth requests', async () => {
		const { d1, request } = fixture({
			handleAuth: async () => new Response('delegated', { status: 202 }),
		});
		d1.queue({ kind: 'first', value: null }, { kind: 'run' });
		expect(
			(
				await request('/api/auth/sign-in/magic-link', {
					method: 'POST',
					body: 'bad',
				})
			).status,
		).toBe(202);
		expect((await request('/api/auth/session')).status).toBe(202);
	});
});

describe('invite-code routes', () => {
	test('lists invite allowance after releasing expired reservations', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'run' }, { kind: 'all', rows: [invite()] });
		const response = await request('/api/v1/invite-codes');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ used: 1, remaining: 4 });
	});

	test.each([
		[{}, 400],
		[{ code: 'root' }, 400],
	] as const)('validates invite creation body', async (body, status) => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'run' });
		expect((await request('/api/v1/invite-codes', json(body))).status).toBe(
			status,
		);
	});

	test('rejects malformed invite creation JSON', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'run' });
		expect(
			(
				await request('/api/v1/invite-codes', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{',
				})
			).status,
		).toBe(400);
	});

	test('creates an invite within the five-code allowance', async () => {
		const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('invite-new');
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'run' },
			{ kind: 'batch' },
			{ kind: 'first', value: { id: 'invite-new' } },
			{ kind: 'first', value: invite({ id: 'invite-new' }) },
		);
		const response = await request(
			'/api/v1/invite-codes',
			json({ code: 'race-2026' }),
		);
		expect(response.status).toBe(201);
		expect(uuid).toHaveBeenCalledTimes(5);
	});

	test('reports an exhausted allowance when the inserted invite cannot be loaded', async () => {
		vi.spyOn(crypto, 'randomUUID').mockReturnValue('invite-new');
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'run' },
			{ kind: 'batch' },
			{ kind: 'first', value: { id: 'invite-new' } },
			{ kind: 'first', value: null },
		);
		expect(
			(await request('/api/v1/invite-codes', json({ code: 'race-2026' })))
				.status,
		).toBe(409);
	});

	test('maps a unique invite race to conflict and rethrows unrelated failures', async () => {
		for (const [error, status] of [
			[new Error('UNIQUE constraint failed: invite_code.code'), 409],
			[new Error('database unavailable'), 500],
			['UNIQUE constraint failed: invite_code.code', 409],
		] as const) {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'run' },
				{
					kind: 'error',
					error,
				},
			);
			expect(
				(await request('/api/v1/invite-codes', json({ code: 'race-2026' })))
					.status,
			).toBe(status);
			d1.expectConsumed();
			active = undefined;
		}
	});

	test.each([
		['exhausted allowance', null, 409],
		['duplicate code', { id: 'foreign-id' }, 409],
	] as const)('reports %s', async (_case, existing, status) => {
		vi.spyOn(crypto, 'randomUUID').mockReturnValue('invite-new');
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'run' },
			{ kind: 'batch' },
			{ kind: 'first', value: existing },
		);
		expect(
			(await request('/api/v1/invite-codes', json({ code: 'race-2026' })))
				.status,
		).toBe(status);
	});

	test.each([
		[[], 404],
		[[invite({ status: 'revoked' })], 200],
	] as const)('revokes an available owned code', async (rows, status) => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'run' }, { kind: 'all', rows: [...rows] });
		expect(
			(
				await request('/api/v1/invite-codes/invite-1/revoke', {
					method: 'POST',
				})
			).status,
		).toBe(status);
	});
});

describe('fallback routing', () => {
	test('handles exact API misses and malformed hidden probes', async () => {
		const { request } = fixture();
		expect((await request('/api')).status).toBe(404);
		expect((await request('/%E0%A4%A')).status).toBe(404);
	});

	test('serves the SPA only for missing HTML GET navigation', async () => {
		const { request } = fixture();
		expect(
			(await request('/garage', { headers: { Accept: 'text/html' } })).status,
		).toBe(200);
		expect((await request('/garage')).status).toBe(404);
		expect(
			(
				await request('/garage', {
					method: 'POST',
					headers: { Accept: 'text/html' },
				})
			).status,
		).toBe(404);
	});
});
