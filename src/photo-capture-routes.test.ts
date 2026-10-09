import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHonoFixture, type D1Step } from './testing/hono-fixture';

const operationId = '30000000-0000-4000-8000-000000000001';
const carId = '40000000-0000-4000-8000-000000000001';
const endpoint = `/api/v1/cars/${carId}/photos/captures/${operationId}`;
const parent = { id: carId, ownerId: 'owner-1', archivedAt: null, version: 1 };
const key = `cars/${carId}/photos/${operationId}`;
const form = (): RequestInit => {
	const body = new FormData();
	body.set('file', new File(['image'], 'car.jpg', { type: 'image/jpeg' }));
	return { method: 'PUT', body };
};
const setup = () => {
	const fixture = createHonoFixture();
	const receipt = {
		ownerId: 'owner-1',
		operationId,
		contractVersion: 1,
		kind: 'photo.capture',
		entityType: 'photo',
		entityId: operationId,
		get requestHash() {
			return fixture.d1.queries[0]?.values[6];
		},
		outcome: 'pending',
		createdAt: '2026-01-01T00:00:00Z',
	};
	const terminal = (outcome = 'applied') => ({
		...receipt,
		outcome,
		httpStatus: outcome === 'applied' ? 200 : 409,
		get responseJson() {
			return [...fixture.d1.batchQueries.flat(), ...fixture.d1.queries]
				.flatMap((query) => query.values)
				.find(
					(value) =>
						typeof value === 'string' &&
						value.startsWith('{"operationId"') &&
						JSON.parse(value).outcome === outcome,
				);
		},
	});
	return { ...fixture, receipt, terminal };
};
const ownedSteps: D1Step[] = [
	{ kind: 'first', value: parent },
	{ kind: 'first', value: null },
	{ kind: 'all', rows: [] },
];
afterEach(() => vi.restoreAllMocks());
describe('idempotent photo capture', () => {
	test('validates capture identity and multipart before database access', async () => {
		const fixture = setup();
		expect(
			(await fixture.request(endpoint.replace(operationId, 'bad'), form()))
				.status,
		).toBe(400);
		expect(
			(await fixture.request(endpoint.replace(carId, 'bad'), form())).status,
		).toBe(400);
		expect((await fixture.request(endpoint, { method: 'PUT' })).status).toBe(
			422,
		);
		expect(fixture.d1.queries).toHaveLength(0);
		expect(
			(
				await createHonoFixture({ authenticated: false }).request(
					endpoint,
					form(),
				)
			).status,
		).toBe(401);
	});
	test('writes immutable bytes and conditional metadata with its receipt', async () => {
		const fixture = setup();
		fixture.d1.queue(
			{ kind: 'first', value: fixture.receipt },
			...ownedSteps,
			{ kind: 'batch' },
			{ kind: 'first', value: fixture.terminal() },
		);
		const response = await fixture.request(endpoint, form());
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			operationId,
			outcome: 'applied',
			photo: { id: operationId, carId, byteSize: 5, isPrimary: true },
		});
		expect(fixture.r2.objects.size).toBe(1);
		expect(fixture.r2.objects.get(key)?.customMetadata).toMatchObject({
			captureOperationId: operationId,
		});
		expect(fixture.d1.batches[0]).toHaveLength(3);
		expect(fixture.d1.batches[0]?.[1]).toContain(
			'"car"."last_operation_id" = ?',
		);
		expect(fixture.d1.batches[0]?.[2]).toContain('exists');
		fixture.d1.expectConsumed();
	});
	test('replays a committed receipt without touching bytes', async () => {
		const fixture = setup();
		fixture.d1.queue(
			{ kind: 'first', value: null },
			{
				kind: 'first',
				value: {
					...fixture.receipt,
					get requestHash() {
						return fixture.receipt.requestHash;
					},
					outcome: 'applied',
					httpStatus: 200,
					responseJson: '{"replayed":true}',
				},
			},
		);
		expect(await (await fixture.request(endpoint, form())).json()).toEqual({
			replayed: true,
		});
		expect(fixture.r2.objects.size).toBe(0);
		fixture.d1.expectConsumed();
	});
	test('rejects operation-id reuse and reports unclaimed receipt as retryable', async () => {
		for (const value of [null, { requestHash: 'different' }]) {
			const fixture = setup();
			fixture.d1.queue(
				{ kind: 'first', value: null },
				{ kind: 'first', value },
			);
			expect((await fixture.request(endpoint, form())).status).toBe(
				value ? 409 : 503,
			);
			fixture.d1.expectConsumed();
		}
	});
	test('retains canonical rejection for missing, archived, or colliding records', async () => {
		for (const steps of [
			[{ kind: 'first', value: null }],
			[{ kind: 'first', value: { ...parent, archivedAt: 'today' } }],
			[
				{ kind: 'first', value: parent },
				{ kind: 'first', value: { id: operationId } },
			],
		] satisfies D1Step[][]) {
			const fixture = setup();
			fixture.d1.queue(
				{ kind: 'first', value: fixture.receipt },
				...steps,
				{ kind: 'run' },
				{ kind: 'first', value: fixture.terminal('rejected') },
			);
			const response = await fixture.request(endpoint, form());
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				operationId,
				outcome: 'rejected',
			});
			expect(fixture.r2.objects.size).toBe(0);
			fixture.d1.expectConsumed();
		}
	});
	test('retries a lost D1 commit against the same R2 object without overwriting it', async () => {
		const fixture = setup();
		fixture.d1.queue(
			{ kind: 'first', value: fixture.receipt },
			...ownedSteps,
			{ kind: 'batch' },
			{ kind: 'first', value: fixture.receipt },
		);
		expect((await fixture.request(endpoint, form())).status).toBe(503);
		const original = fixture.r2.objects.get(key);
		fixture.d1.queue(
			{ kind: 'first', value: null },
			{ kind: 'first', value: fixture.receipt },
			...ownedSteps,
			{ kind: 'batch' },
			{ kind: 'first', value: fixture.terminal() },
		);
		expect((await fixture.request(endpoint, form())).status).toBe(200);
		expect(fixture.r2.objects.get(key)).toBe(original);
		fixture.d1.expectConsumed();
	});
	test('does not overwrite an object with another request identity', async () => {
		const fixture = setup();
		await fixture.r2.bucket.put(key, 'original');
		fixture.d1.queue(
			{ kind: 'first', value: fixture.receipt },
			...ownedSteps,
			{ kind: 'run' },
			{ kind: 'first', value: fixture.terminal('rejected') },
		);
		expect((await fixture.request(endpoint, form())).status).toBe(409);
		expect(await (await fixture.r2.bucket.get(key))?.text()).toBe('original');
		fixture.d1.expectConsumed();
	});
	test('fails closed when R2 conditional put loses its object before head', async () => {
		const fixture = setup();
		vi.spyOn(fixture.r2.bucket, 'put').mockResolvedValue(null);
		fixture.d1.queue(
			{ kind: 'first', value: fixture.receipt },
			...ownedSteps,
			{ kind: 'run' },
			{ kind: 'first', value: fixture.terminal('rejected') },
		);
		expect((await fixture.request(endpoint, form())).status).toBe(409);
		fixture.d1.expectConsumed();
	});
	test('keeps pending or incomplete receipts retryable', async () => {
		for (const value of [
			null,
			{ outcome: 'applied', httpStatus: null, responseJson: null },
			{ outcome: 'applied', httpStatus: 200, responseJson: null },
		]) {
			const fixture = setup();
			fixture.d1.queue(
				{ kind: 'first', value: fixture.receipt },
				...ownedSteps,
				{ kind: 'batch' },
				{ kind: 'first', value },
			);
			expect((await fixture.request(endpoint, form())).status).toBe(503);
			fixture.d1.expectConsumed();
		}
	});
	test('preserves an existing primary photo and scopes metadata reads to the owner', async () => {
		const fixture = setup();
		fixture.d1.queue(
			{ kind: 'first', value: fixture.receipt },
			...ownedSteps.slice(0, 2),
			{ kind: 'all', rows: [{ isPrimary: true }] },
			{ kind: 'batch' },
			{ kind: 'first', value: fixture.terminal() },
		);
		expect(
			await (await fixture.request(endpoint, form())).json(),
		).toMatchObject({ photo: { isPrimary: false, sortOrder: 1 } });
		fixture.d1.queue({
			kind: 'all',
			rows: [
				{
					id: operationId,
					carId,
					objectKey: key,
					contentType: 'image/jpeg',
					fileName: 'car.jpg',
					byteSize: 5,
					sortOrder: 0,
					isPrimary: true,
					createdAt: 'now',
				},
			],
		});
		expect(
			await (await fixture.request('/api/v1/photos')).json(),
		).toMatchObject({ photos: [{ id: operationId, carId }] });
		expect(fixture.d1.queries.at(-1)).toMatchObject({ values: ['owner-1'] });
		fixture.d1.expectConsumed();
	});
	test('cleans its own abandoned upload only after a terminal rejection and guards duplicate writers by receipt', async () => {
		const fixture = setup();
		fixture.d1.queue(
			{ kind: 'first', value: fixture.receipt },
			...ownedSteps,
			{ kind: 'batch' },
			{ kind: 'first', value: fixture.receipt },
		);
		expect((await fixture.request(endpoint, form())).status).toBe(503);
		expect(fixture.r2.objects.has(key)).toBe(true);
		expect(fixture.d1.batches[0][0]).toContain('sync_operation');
		expect(fixture.d1.batches[0][1]).toContain('sync_operation');
		fixture.d1.queue(
			{ kind: 'first', value: fixture.receipt },
			{ kind: 'first', value: { ...parent, archivedAt: 'today' } },
			{ kind: 'run' },
			{ kind: 'first', value: fixture.terminal('rejected') },
		);
		expect((await fixture.request(endpoint, form())).status).toBe(409);
		expect(fixture.r2.objects.has(key)).toBe(false);
		fixture.d1.expectConsumed();
	});
});
