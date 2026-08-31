import { describe, expect, test } from 'vitest';
import { createHonoFixture } from './testing/hono-fixture';

const html = { headers: { Accept: 'text/html' } };

describe('SEO indexing boundaries', () => {
	test('keeps the landing page indexable', async () => {
		const { request } = createHonoFixture();
		const response = await request('/', html);

		expect(response.status).toBe(200);
		expect(response.headers.has('X-Robots-Tag')).toBe(false);
	});

	test('keeps a landing-page fallback indexable', async () => {
		const { request } = createHonoFixture();
		const response = await request('/?asset-miss=1', html);

		expect(response.status).toBe(200);
		expect(response.headers.has('X-Robots-Tag')).toBe(false);
	});

	test.each([
		'/sign-in',
		'/garage',
		'/garage/123/setups',
		'/some-unknown-route',
	])('marks SPA route %s as noindex', async (path) => {
		const { request } = createHonoFixture();
		const response = await request(path, html);

		expect(response.status).toBe(200);
		expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
	});

	test('leaves static assets and API responses without noindex', async () => {
		const { request } = createHonoFixture();
		const asset = await request('/assets/app.js');
		const api = await request('/api/does-not-exist');

		expect(asset.status).toBe(200);
		expect(asset.headers.has('X-Robots-Tag')).toBe(false);
		expect(api.status).toBe(404);
		expect(api.headers.has('X-Robots-Tag')).toBe(false);
	});

	test.each([
		['https://www.chassisnotes.com/', 'https://chassisnotes.com/'],
		[
			'https://www.chassisnotes.com/garage/123?foo=bar',
			'https://chassisnotes.com/garage/123?foo=bar',
		],
	])('redirects www host %s to %s', async (url, location) => {
		const { request } = createHonoFixture();
		const response = await request(url, { redirect: 'manual' });

		expect(response.status).toBe(308);
		expect(response.headers.get('Location')).toBe(location);
	});

	test('leaves apex host untouched', async () => {
		const { request } = createHonoFixture();
		const response = await request('https://chassisnotes.com/', html);

		expect(response.status).toBe(200);
		expect(response.headers.has('Location')).toBe(false);
	});
});
