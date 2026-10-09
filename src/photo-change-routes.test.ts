import { afterEach, expect, test, vi } from 'vitest';
import {
	applyPhotoChange,
	type PhotoChange,
	photoBase,
} from '../shared/photo-sync';
import { createHonoFixture } from './testing/hono-fixture';

const carId = '40000000-0000-4000-8000-000000000001',
	operationId = '30000000-0000-4000-8000-000000000001';
const first = {
	id: '50000000-0000-4000-8000-000000000001',
	carId,
	revision: 1,
	objectKey: 'old/one',
	contentType: 'image/jpeg',
	fileName: 'car.jpg',
	byteSize: 3,
	sortOrder: 0,
	isPrimary: true,
	createdAt: 'today',
};
const second = {
	...first,
	id: '50000000-0000-4000-8000-000000000002',
	objectKey: 'old/two',
	sortOrder: 1,
	isPrimary: false,
};
const endpoint = `/api/v1/cars/${carId}/photos/operations/${operationId}`;
const change = (action: PhotoChange['action'] = 'primary'): PhotoChange => ({
	type: 'photo.change',
	carId,
	action,
	photoId: action === 'reorder' ? null : second.id,
	order: action === 'reorder' ? [second.id, first.id] : [],
	base: photoBase(
		action === 'replace' || action === 'delete' ? [second] : [first, second],
	),
	replacement:
		action === 'replace'
			? { fileName: 'car.jpg', contentType: 'image/jpeg', byteSize: 3 }
			: null,
});
const form = (command: unknown = change(), file?: File): RequestInit => {
	const body = new FormData();
	body.set('command', JSON.stringify(command));
	if (file) body.set('file', file);
	else if ((command as PhotoChange).replacement)
		body.set('file', new File(['new'], 'car.jpg', { type: 'image/jpeg' }));
	return { method: 'PUT', body };
};
const setup = () => {
	const fixture = createHonoFixture();
	const receipt = {
		ownerId: 'owner-1',
		operationId,
		contractVersion: 1,
		kind: 'photo.change',
		entityType: 'photo',
		entityId: carId,
		get requestHash() {
			return fixture.d1.queries[0]?.values[6];
		},
		outcome: 'pending',
		createdAt: 'now',
	};
	const terminal = (outcome = 'applied') => ({
		...receipt,
		outcome,
		httpStatus: outcome === 'applied' ? 200 : 409,
		get responseJson() {
			return [...fixture.d1.batchQueries.flat(), ...fixture.d1.queries]
				.flatMap((value) => value.values)
				.find(
					(value) =>
						typeof value === 'string' &&
						value.startsWith('{"response"') &&
						JSON.parse(value).response.outcome === outcome,
				);
		},
	});
	const owned = () =>
		fixture.d1.queue(
			{ kind: 'first', value: receipt },
			{
				kind: 'first',
				value: { id: carId, ownerId: 'owner-1', version: 1, archivedAt: null },
			},
			{ kind: 'all', rows: [first, second] },
		);
	return { ...fixture, receipt, terminal, owned };
};
afterEach(() => vi.restoreAllMocks());
test('rejects invalid contracts and mismatched bytes before touching storage', async () => {
	const f = setup();
	for (const command of [
		{},
		{ ...change(), carId: operationId },
		{ ...change(), extra: true },
		{
			...change(),
			base: [
				{ id: first.id, revision: 1 },
				{ id: first.id, revision: 1 },
			],
		},
		{ ...change(), photoId: null },
		{ ...change(), photoId: operationId },
		{ ...change(), order: [first.id] },
		{ ...change('reorder'), photoId: first.id },
		{ ...change('reorder'), order: [] },
		{ ...change('reorder'), order: [first.id, first.id] },
		{ ...change('reorder'), order: [first.id, operationId] },
		{ ...change('replace'), replacement: null },
	])
		expect((await f.request(endpoint, form(command))).status).toBe(422);
	expect(
		(await f.request(endpoint.replace(operationId, 'invalid'), form())).status,
	).toBe(400);
	expect(
		(await f.request(endpoint, { method: 'PUT', body: 'bad' })).status,
	).toBe(422);
	for (const file of [
		new File(['x'], 'car.jpg', { type: 'image/jpeg' }),
		new File(['new'], 'other.jpg', { type: 'image/jpeg' }),
		new File(['new'], 'car.jpg', { type: 'image/png' }),
	])
		expect(
			(await f.request(endpoint, form(change('replace'), file))).status,
		).toBe(422);
	expect(
		(await f.request(endpoint, form(change(), new File(['x'], 'x')))).status,
	).toBe(422);
	const missing = new FormData();
	missing.set('command', JSON.stringify(change('replace')));
	expect(
		(await f.request(endpoint, { method: 'PUT', body: missing })).status,
	).toBe(422);
	expect(f.d1.queries).toHaveLength(0);
	expect(
		(
			await createHonoFixture({ authenticated: false }).request(
				endpoint,
				form(),
			)
		).status,
	).toBe(401);
});
test.each(['primary', 'reorder', 'replace', 'delete'] as const)(
	'atomically applies %s with legacy revision and gallery membership witnesses',
	async (action) => {
		const f = setup();
		await f.r2.bucket.put(second.objectKey, 'old');
		f.owned();
		f.d1.queue(
			{ kind: 'batch', changes: [1, 1, 1, 1] },
			{ kind: 'first', value: f.terminal() },
		);
		const response = await f.request(endpoint, form(change(action)));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			operationId,
			outcome: 'applied',
		});
		expect(f.d1.batches[0][0]).toContain('revision');
		expect(f.d1.batches[0][0]).toContain('count(*)');
		expect(f.d1.batches[0].at(-1)).toContain('last_operation_id');
		expect(f.r2.objects.has(second.objectKey)).toBe(
			!['replace', 'delete'].includes(action),
		);
		f.d1.expectConsumed();
	},
);
test('replays cleanup without applying a mutation twice and keeps cleanup failures retryable', async () => {
	const f = setup();
	const saved = {
		...f.receipt,
		get requestHash() {
			return f.receipt.requestHash;
		},
		outcome: 'applied',
		httpStatus: 200,
		responseJson: JSON.stringify({
			response: { operationId, outcome: 'applied', photos: [] },
			cleanup: ['old/one'],
		}),
	};
	for (const fail of [true, false]) {
		f.d1.queue({ kind: 'first', value: null }, { kind: 'first', value: saved });
		if (fail)
			vi.spyOn(f.r2.bucket, 'delete').mockRejectedValueOnce(
				new Error('R2 unavailable'),
			);
		expect((await f.request(endpoint, form())).status).toBe(fail ? 503 : 200);
	}
	expect(f.d1.batches).toHaveLength(0);
	f.d1.expectConsumed();
});
test('fences identity reuse, absent receipts, and incomplete terminal receipts', async () => {
	for (const value of [null, { requestHash: 'other' }]) {
		const f = setup();
		f.d1.queue({ kind: 'first', value: null }, { kind: 'first', value });
		expect((await f.request(endpoint, form())).status).toBe(value ? 409 : 503);
		f.d1.expectConsumed();
	}
	for (const value of [
		null,
		{ outcome: 'pending' },
		{ outcome: 'applied', httpStatus: null, responseJson: null },
		{ outcome: 'applied', httpStatus: 200, responseJson: null },
	]) {
		const f = setup();
		f.owned();
		f.d1.queue(
			{ kind: 'batch', changes: [1, 1, 1, 1] },
			{ kind: 'first', value },
		);
		expect((await f.request(endpoint, form())).status).toBe(503);
		f.d1.expectConsumed();
	}
});
test('retains canonical conflict and rejection evidence without changing bytes', async () => {
	for (const parent of [
		null,
		{ id: carId, ownerId: 'owner-1', version: 1, archivedAt: 'today' },
	]) {
		const f = setup();
		f.d1.queue(
			{ kind: 'first', value: f.receipt },
			{ kind: 'first', value: parent },
			{ kind: 'run' },
			{ kind: 'first', value: f.terminal('rejected') },
		);
		expect((await f.request(endpoint, form())).status).toBe(409);
		f.d1.expectConsumed();
	}
	const f = setup();
	f.owned();
	f.d1.queue({ kind: 'run' }, { kind: 'first', value: f.terminal('conflict') });
	const response = await f.request(
		endpoint,
		form({ ...change(), base: photoBase([{ ...first, revision: 2 }, second]) }),
	);
	expect(await response.json()).toMatchObject({
		outcome: 'conflict',
		remote: [{ id: first.id, revision: 1 }, { id: second.id }],
	});
	expect(f.d1.batches).toHaveLength(0);
	f.d1.expectConsumed();
});
test('retries an immutable replacement after a lost database write and refuses another object identity', async () => {
	const key = `cars/${carId}/photo-changes/${operationId}`;
	const f = setup();
	f.owned();
	f.d1.queue({ kind: 'batch', changes: [0] });
	expect((await f.request(endpoint, form(change('replace')))).status).toBe(503);
	const retained = f.r2.objects.get(key);
	f.owned();
	f.d1.queue(
		{ kind: 'batch', changes: [1, 1, 1] },
		{ kind: 'first', value: f.terminal() },
	);
	expect((await f.request(endpoint, form(change('replace')))).status).toBe(200);
	expect(f.r2.objects.get(key)).toBe(retained);
	f.d1.expectConsumed();
	for (const missing of [true, false]) {
		const g = setup();
		if (missing) vi.spyOn(g.r2.bucket, 'put').mockResolvedValue(null);
		else await g.r2.bucket.put(key, 'other');
		g.owned();
		g.d1.queue(
			{ kind: 'run' },
			{ kind: 'first', value: g.terminal('rejected') },
		);
		expect((await g.request(endpoint, form(change('replace')))).status).toBe(
			409,
		);
		g.d1.expectConsumed();
	}
});
test('pure gallery changes preserve independent records, stable order, and primary after deletion', () => {
	expect(
		applyPhotoChange([first, second], {
			...change('delete'),
			photoId: first.id,
		}),
	).toMatchObject([{ id: second.id, isPrimary: true, revision: 2 }]);
	expect(
		applyPhotoChange([first], { ...change('delete'), photoId: first.id }),
	).toEqual([]);
	expect(
		applyPhotoChange([first, second], {
			...change('primary'),
			photoId: first.id,
		}),
	).toEqual([first, second]);
	expect(photoBase([{ ...first, revision: undefined }])).toEqual([
		{ id: first.id, revision: 1 },
	]);
	const absent = { ...second, sortOrder: undefined, revision: undefined };
	expect(applyPhotoChange([first, absent], change('primary'))[1].revision).toBe(
		2,
	);
	expect(
		applyPhotoChange([first, { ...absent, id: 'a' }, { ...absent, id: 'b' }], {
			...change('delete'),
			photoId: first.id,
		}),
	).toMatchObject([
		{ id: 'a', isPrimary: true },
		{ id: 'b', isPrimary: false },
	]);
	expect(
		applyPhotoChange([first, second], {
			...change('replace'),
			replacement: null,
		}),
	).toEqual([first, second]);
});

test('merges an unrelated photo edit and cleans a replacement abandoned after a lost admission race', async () => {
	const f = setup();
	f.d1.queue(
		{ kind: 'first', value: f.receipt },
		{
			kind: 'first',
			value: { id: carId, ownerId: 'owner-1', version: 2, archivedAt: null },
		},
		{
			kind: 'all',
			rows: [{ ...first, revision: 5, fileName: 'independent.jpg' }, second],
		},
		{ kind: 'batch', changes: [1, 1, 1] },
		{ kind: 'first', value: f.terminal() },
	);
	const response = await f.request(endpoint, form(change('replace')));
	expect(await response.json()).toMatchObject({
		outcome: 'applied',
		photos: [
			{ id: first.id, revision: 5, fileName: 'independent.jpg' },
			{ id: second.id, revision: 2 },
		],
	});
	f.d1.expectConsumed();
	const g = setup();
	g.owned();
	g.d1.queue({ kind: 'batch', changes: [0] });
	expect((await g.request(endpoint, form(change('replace')))).status).toBe(503);
	const key = `cars/${carId}/photo-changes/${operationId}`;
	expect(g.r2.objects.has(key)).toBe(true);
	g.d1.queue(
		{ kind: 'first', value: g.receipt },
		{
			kind: 'first',
			value: { id: carId, ownerId: 'owner-1', version: 2, archivedAt: null },
		},
		{ kind: 'all', rows: [first, { ...second, revision: 2 }] },
		{ kind: 'run' },
		{ kind: 'first', value: g.terminal('conflict') },
	);
	expect((await g.request(endpoint, form(change('replace')))).status).toBe(409);
	expect(g.r2.objects.has(key)).toBe(false);
	g.d1.expectConsumed();
});
