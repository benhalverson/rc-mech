import { expect, test } from 'vitest';
import app from './index';

const emptyResult = <T = Record<string, unknown>>(): D1Result<T> => ({
	success: true,
	meta: {} as D1Meta & Record<string, unknown>,
	results: [],
});

const mockD1 = (): D1Database => {
	const statement = {
		bind: (..._values: unknown[]) => statement,
		first: async <T = Record<string, unknown>>(_columnName?: string) =>
			null as T | null,
		all: async <T = Record<string, unknown>>() => emptyResult<T>(),
		run: async <T = Record<string, unknown>>() => emptyResult<T>(),
	};

	return {
		prepare: (_query: string) => statement,
		batch: async <T = unknown>(_statements: D1PreparedStatement[]) =>
			_statements.map(() => emptyResult<T>()),
	} as unknown as D1Database;
};

const mockR2 = {
	head: async () => null,
	get: async () => null,
	put: async () => null,
	delete: async () => undefined,
	list: async () => ({ objects: [], truncated: false }),
} as unknown as R2Bucket;

const MOCK_ENV = {
	DB: mockD1(),
	PHOTOS: mockR2,
	EMAIL: {
		send: async () => {
			throw new Error('Unexpected email delivery in backend tests');
		},
	},
	ASSETS: {
		fetch: async () => new Response('Not found', { status: 404 }),
	} as unknown as Fetcher,
	APP_URL: 'http://localhost:8787',
	ENVIRONMENT: 'local',
} satisfies Env;

const request = (path: string, init?: RequestInit) =>
	app.request(path, init, MOCK_ENV);

test('health is exposed through the Worker request interface', async () => {
	const response = await request('/api/v1/health');

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ok: true, service: 'rc-mech' });
});

test('OpenAPI documents invite registration and management endpoints', async () => {
	const response = await request('/api/openapi.json');
	const document = (await response.json()) as {
		paths: Record<string, unknown>;
	};

	expect(response.status).toBe(200);
	expect(document.paths['/api/auth/register']).toBeDefined();
	expect(document.paths['/api/v1/invite-codes']).toBeDefined();
	expect(document.paths['/api/v1/invite-codes/{id}/revoke']).toBeDefined();
});

test('unknown API routes return the JSON API 404 contract', async () => {
	const response = await request('/api/does-not-exist');

	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: 'Not found' });
});

test('protected routes require authentication using the configured D1 binding', async () => {
	const response = await request('/api/v1/cars');

	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ error: 'Authentication required' });
});

test('authentication rejects invalid request input through the Worker interface', async () => {
	const response = await request('/api/auth/sign-in/magic-link', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email: 123 }),
	});

	expect(response.status).toBe(400);
});

test('test fixtures expose configured D1 and R2 bindings', () => {
	expect(MOCK_ENV.DB).toBeDefined();
	expect(MOCK_ENV.PHOTOS).toBeDefined();
});
