import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	createHonoFixture,
	type MockD1Controller,
} from './testing/hono-fixture';

const car = (overrides: Record<string, unknown> = {}) => ({
	id: 'car-1',
	ownerId: 'owner-1',
	name: 'Buggy',
	make: null,
	model: null,
	scale: null,
	vehicleType: null,
	powerType: null,
	notes: null,
	currentSetupId: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	archivedAt: null,
	...overrides,
});

const photo = (overrides: Record<string, unknown> = {}) => ({
	id: 'photo-1',
	carId: 'car-1',
	objectKey: 'cars/car-1/photos/photo-1',
	contentType: 'image/jpeg',
	fileName: 'car.jpg',
	byteSize: 5,
	sortOrder: 0,
	isPrimary: true,
	createdAt: '2026-01-01T00:00:00.000Z',
	...overrides,
});

const json = (body: unknown): RequestInit => ({
	method: 'PATCH',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

const form = (
	fields: Record<string, string> = {},
	file = true,
): RequestInit => {
	const body = new FormData();
	if (file)
		body.set('file', new File(['image'], 'car.jpg', { type: 'image/jpeg' }));
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return { method: 'POST', body };
};

let current: MockD1Controller | undefined;
const fixture = () => {
	const value = createHonoFixture();
	current = value.d1;
	return value;
};
afterEach(() => {
	current?.expectConsumed();
	current = undefined;
	vi.restoreAllMocks();
});

describe('photo routes', () => {
	test('lists normalized photos for an owned car', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{
				kind: 'all',
				rows: [photo({ sortOrder: 2 }), photo({ id: 'photo-2', sortOrder: 1 })],
			},
		);
		const response = await request('/api/v1/cars/car-1/photos');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			photos: [
				{ id: 'photo-2', sortOrder: 1 },
				{ id: 'photo-1', sortOrder: 2 },
			],
		});
	});

	test('hides a missing car photo collection', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: null });
		const response = await request('/api/v1/cars/missing/photos');
		expect(response.status).toBe(404);
	});

	test.each([
		[
			[photo(), photo({ id: 'photo-2', sortOrder: 1 })],
			['photo-2', 'photo-1'],
		],
		[[], []],
	] as const)(
		'reorders a complete owned photo set',
		async (existing, photoIds) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'all', rows: [...existing] },
				...(existing.length ? [{ kind: 'batch' } as const] : []),
				{ kind: 'all', rows: [...existing] },
			);
			const response = await request(
				'/api/v1/cars/car-1/photos/reorder',
				json({ photoIds }),
			);
			expect(response.status).toBe(200);
		},
	);

	test.each([
		['missing car', null, { photoIds: [] }, [], 404],
		[
			'archived car',
			car({ archivedAt: '2026-01-01T00:00:00.000Z' }),
			{ photoIds: [] },
			[],
			409,
		],
		['invalid body', car(), { photoIds: 'bad' }, [], 400],
		['incomplete order', car(), { photoIds: [] }, [photo()], 400],
	] as const)(
		'rejects reorder for %s',
		async (_case, parent, body, rows, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: parent });
			if (rows.length) d1.queue({ kind: 'all', rows: [...rows] });
			const response = await request(
				'/api/v1/cars/car-1/photos/reorder',
				json(body),
			);
			expect(response.status).toBe(status);
		},
	);

	test.each([
		['first primary', [], {}, true],
		['explicit primary', [photo()], { primary: 'true', sortOrder: '1' }, true],
		['secondary', [photo()], { primary: 'false' }, false],
	] as const)(
		'uploads a %s photo with R2 compensation metadata',
		async (_case, existing, fields, primary) => {
			const { d1, r2, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'all', rows: [...existing] },
				{ kind: 'batch' },
				{ kind: 'first', value: photo({ isPrimary: primary }) },
			);
			const response = await request('/api/v1/cars/car-1/photos', form(fields));
			expect(response.status).toBe(201);
			expect(r2.objects.size).toBe(1);
		},
	);

	test.each([
		['missing car', null, form(), 404],
		[
			'archived car',
			car({ archivedAt: '2026-01-01T00:00:00.000Z' }),
			form(),
			409,
		],
		['missing file', car(), form({}, false), 400],
	] as const)('rejects upload for %s', async (_case, parent, init, status) => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: parent });
		const response = await request('/api/v1/cars/car-1/photos', init);
		expect(response.status).toBe(status);
	});

	test('rejects an invalid photo sort order', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: car() }, { kind: 'all', rows: [] });
		const response = await request(
			'/api/v1/cars/car-1/photos',
			form({ sortOrder: '-1' }),
		);
		expect(response.status).toBe(400);
	});

	test('rejects unsupported photo contents after parsing multipart data', async () => {
		const { d1, request } = fixture();
		const body = new FormData();
		body.set('file', new File(['text'], 'notes.txt', { type: 'text/plain' }));
		d1.queue({ kind: 'first', value: car() });
		expect(
			(
				await request('/api/v1/cars/car-1/photos', {
					method: 'POST',
					body,
				})
			).status,
		).toBe(400);
	});

	test('deletes the R2 object when photo metadata insertion fails', async () => {
		const { d1, r2, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [] },
			{ kind: 'error', error: new Error('insert failed') },
		);
		const response = await request('/api/v1/cars/car-1/photos', form());
		expect(response.status).toBe(500);
		expect(r2.objects.size).toBe(0);
	});

	test.each([
		[
			'primary',
			{ isPrimary: true, sortOrder: 3 },
			[photo({ id: 'photo-2', isPrimary: false })],
		],
		[
			'demoted with replacement',
			{ isPrimary: false },
			[photo({ id: 'photo-2', isPrimary: false })],
		],
		['demoted alone', { isPrimary: false }, []],
		['sort only', { sortOrder: 2 }, []],
	] as const)('updates photo metadata as %s', async (_case, body, others) => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: photo() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
		);
		if ('isPrimary' in body && body.isPrimary === false)
			d1.queue({ kind: 'all', rows: Array.from(others) });
		d1.queue('isPrimary' in body ? { kind: 'batch' } : { kind: 'run' });
		d1.queue({ kind: 'first', value: photo({ ...body }) });
		const response = await request('/api/v1/photos/photo-1', json(body));
		expect(response.status).toBe(200);
	});

	test.each([
		['missing photo', [null], {}, 404],
		['missing parent', [photo(), null], {}, 404],
		[
			'archived parent',
			[photo(), car(), car({ archivedAt: '2026-01-01T00:00:00.000Z' })],
			{},
			409,
		],
		['invalid body', [photo(), car(), car()], { sortOrder: -1 }, 400],
	] as const)(
		'rejects photo update for %s',
		async (_case, rows, body, status) => {
			const { d1, request } = fixture();
			for (const value of rows) d1.queue({ kind: 'first', value });
			const response = await request('/api/v1/photos/photo-1', json(body));
			expect(response.status).toBe(status);
		},
	);

	test.each(['POST', 'PUT'] as const)(
		'%s replaces photo bytes and metadata',
		async (method) => {
			const { d1, r2, request } = fixture();
			r2.seed('cars/car-1/photos/photo-1', 'old');
			d1.queue(
				{ kind: 'first', value: photo() },
				{ kind: 'first', value: car() },
				{ kind: 'first', value: car() },
				{ kind: 'first', value: photo({ byteSize: 5 }) },
			);
			const init = form();
			init.method = method;
			const response = await request(
				method === 'POST'
					? '/api/v1/photos/photo-1/replace'
					: '/api/v1/photos/photo-1',
				init,
			);
			expect(response.status).toBe(200);
			expect(
				await r2.bucket
					.get('cars/car-1/photos/photo-1')
					.then((value) => value?.text()),
			).toBe('image');
		},
	);

	test('restores previous photo bytes when metadata replacement fails', async () => {
		const { d1, r2, request } = fixture();
		r2.seed('cars/car-1/photos/photo-1', 'old');
		d1.queue(
			{ kind: 'first', value: photo() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'error', error: new Error('update failed') },
		);
		const response = await request('/api/v1/photos/photo-1/replace', form());
		expect(response.status).toBe(500);
		expect(
			await r2.bucket
				.get('cars/car-1/photos/photo-1')
				.then((value) => value?.text()),
		).toBe('old');
	});

	test('deletes a primary photo and promotes its replacement', async () => {
		const { d1, r2, request } = fixture();
		r2.seed('cars/car-1/photos/photo-1', 'image');
		d1.queue(
			{ kind: 'first', value: photo() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [photo({ id: 'photo-2', isPrimary: false })] },
			{ kind: 'batch' },
		);
		const response = await request('/api/v1/photos/photo-1', {
			method: 'DELETE',
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			deleted: true,
			primaryPhotoId: 'photo-2',
		});
	});

	test('deletes a non-primary photo without replacement', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: photo({ isPrimary: false }) },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [] },
			{ kind: 'batch' },
		);
		const response = await request('/api/v1/photos/photo-1', {
			method: 'DELETE',
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			deleted: true,
			primaryPhotoId: null,
		});
	});

	test('returns photo bytes with private content headers', async () => {
		const { d1, r2, request } = fixture();
		r2.seed('cars/car-1/photos/photo-1', 'image');
		d1.queue(
			{ kind: 'first', value: photo({ fileName: 'bad"name.jpg' }) },
			{ kind: 'first', value: car() },
		);
		const response = await request('/api/v1/photos/photo-1');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('image');
		expect(response.headers.get('cache-control')).toBe('private, max-age=300');
		expect(response.headers.get('content-disposition')).toContain(
			'bad_name.jpg',
		);
	});

	test('returns 404 when photo metadata or bytes are absent', async () => {
		for (const rows of [[null], [photo(), car()]] as const) {
			const { d1, request } = fixture();
			for (const value of rows) d1.queue({ kind: 'first', value });
			const response = await request('/api/v1/photos/photo-1');
			expect(response.status).toBe(404);
			d1.expectConsumed();
			current = undefined;
		}
	});

	test('car-scoped photo routes reject mismatched ownership metadata', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: photo({ carId: 'car-2' }) },
			{ kind: 'first', value: car({ id: 'car-2' }) },
		);
		const response = await request(
			'/api/v1/cars/car-1/photos/photo-1',
			json({ sortOrder: 1 }),
		);
		expect(response.status).toBe(404);
	});

	test.each([
		['POST', '/api/v1/cars/car-1/photos/missing/replace'],
		['DELETE', '/api/v1/cars/car-1/photos/missing'],
	] as const)(
		'executes the car-scoped %s delegate for a missing photo',
		async (method, path) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: null });
			expect((await request(path, { method })).status).toBe(404);
		},
	);

	test.each([
		['POST', '/api/v1/photos/photo-1/replace', form()],
		['DELETE', '/api/v1/photos/photo-1', { method: 'DELETE' }],
	] as const)(
		'rejects %s when the photo parent lookup disappears',
		async (_method, path, init) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: photo() },
				{ kind: 'first', value: car() },
				{ kind: 'first', value: null },
			);
			expect((await request(path, init)).status).toBe(404);
		},
	);

	test.each([
		['POST', '/api/v1/photos/photo-1/replace', form()],
		['DELETE', '/api/v1/photos/photo-1', { method: 'DELETE' }],
	] as const)(
		'rejects %s photo mutations for an archived car',
		async (_method, path, init) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: photo() },
				{ kind: 'first', value: car() },
				{
					kind: 'first',
					value: car({ archivedAt: '2026-01-01T00:00:00.000Z' }),
				},
			);
			expect((await request(path, init)).status).toBe(409);
		},
	);

	test('rejects replacement without a valid file', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: photo() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
		);
		const init = form({}, false);
		init.method = 'POST';
		expect((await request('/api/v1/photos/photo-1/replace', init)).status).toBe(
			400,
		);
	});

	test('returns 503 without changing metadata when R2 deletion fails', async () => {
		const { d1, env, request } = fixture();
		d1.queue(
			{ kind: 'first', value: photo() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [] },
		);
		vi.spyOn(env.PHOTOS, 'delete').mockRejectedValueOnce(
			new Error('R2 unavailable'),
		);
		expect(
			(await request('/api/v1/photos/photo-1', { method: 'DELETE' })).status,
		).toBe(503);
	});

	test('surfaces metadata deletion failure when there were no bytes to restore', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: photo() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [] },
			{ kind: 'error', error: new Error('metadata delete failed') },
		);
		expect(
			(await request('/api/v1/photos/photo-1', { method: 'DELETE' })).status,
		).toBe(500);
	});

	test.each([
		['POST', '/api/v1/photos/missing/replace'],
		['DELETE', '/api/v1/photos/missing'],
	] as const)(
		'returns 404 for a missing photo on direct %s mutation',
		async (method, path) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: null });
			expect((await request(path, { method })).status).toBe(404);
		},
	);

	test('successfully delegates a car-scoped photo update', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: photo() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: photo() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'first', value: photo({ sortOrder: 3 }) },
		);
		expect(
			(
				await request(
					'/api/v1/cars/car-1/photos/photo-1',
					json({ sortOrder: 3 }),
				)
			).status,
		).toBe(200);
	});

	test('returns 404 when the parent disappears between owned-photo checks', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: photo() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: null },
		);
		expect(
			(await request('/api/v1/photos/photo-1', json({ sortOrder: 1 }))).status,
		).toBe(404);
	});

	test('deletes replacement bytes when metadata replacement fails without a previous object', async () => {
		const { d1, r2, request } = fixture();
		d1.queue(
			{ kind: 'first', value: photo() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'error', error: new Error('update failed') },
		);
		expect(
			(await request('/api/v1/photos/photo-1/replace', form())).status,
		).toBe(500);
		expect(r2.objects.size).toBe(0);
	});

	test('logs a failed R2 upload compensation without hiding the D1 failure', async () => {
		const { d1, env, request } = fixture();
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(env.PHOTOS, 'delete').mockRejectedValueOnce(
			new Error('delete failed'),
		);
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [] },
			{ kind: 'error', error: new Error('insert failed') },
		);
		expect((await request('/api/v1/cars/car-1/photos', form())).status).toBe(
			500,
		);
	});

	test('logs a failed R2 delete compensation without hiding the D1 failure', async () => {
		const { d1, env, r2, request } = fixture();
		r2.seed('cars/car-1/photos/photo-1', 'image');
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(env.PHOTOS, 'put').mockRejectedValueOnce(
			new Error('restore failed'),
		);
		d1.queue(
			{ kind: 'first', value: photo() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [] },
			{ kind: 'error', error: new Error('metadata delete failed') },
		);
		expect(
			(await request('/api/v1/photos/photo-1', { method: 'DELETE' })).status,
		).toBe(500);
	});

	test('logs a failed R2 replace compensation without hiding the D1 failure', async () => {
		const { d1, env, r2, request } = fixture();
		r2.seed('cars/car-1/photos/photo-1', 'old');
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const put = env.PHOTOS.put.bind(env.PHOTOS);
		vi.spyOn(env.PHOTOS, 'put')
			.mockImplementationOnce(put)
			.mockRejectedValueOnce(new Error('restore failed'));
		d1.queue(
			{ kind: 'first', value: photo() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'error', error: new Error('metadata update failed') },
		);
		expect(
			(await request('/api/v1/photos/photo-1/replace', form())).status,
		).toBe(500);
	});
});
