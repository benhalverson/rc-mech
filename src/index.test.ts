import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import app from './index';

const request = (path: string, init?: RequestInit) =>
	app.fetch(new Request(`http://example.com${path}`, init), env);

test('health is exposed through the Worker request interface', async () => {
	const response = await request('/api/v1/health');

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ok: true, service: 'rc-mech' });
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

test('Worker test fixtures expose configured D1 and R2 bindings', () => {
	expect(env.DB).toBeDefined();
	expect(env.PHOTOS).toBeDefined();
});
