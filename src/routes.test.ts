import { afterEach, describe, expect, test } from 'vitest';
import {
	createHonoFixture,
	type MockD1Controller,
} from './testing/hono-fixture';

const carRow = (
	overrides: Partial<{
		id: string;
		ownerId: string | null;
		name: string;
		make: string | null;
		model: string | null;
		scale: string | null;
		vehicleType: string | null;
		powerType: string | null;
		notes: string | null;
		currentSetupId: string | null;
		createdAt: string;
		archivedAt: string | null;
		version: number;
		lastOperationId: string | null;
	}> = {},
) => ({
	id: 'car-1',
	ownerId: 'owner-1',
	name: 'Race buggy',
	make: null,
	model: null,
	scale: '1/10',
	vehicleType: 'buggy',
	powerType: 'electric',
	notes: null,
	currentSetupId: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	archivedAt: null,
	version: 1,
	lastOperationId: null,
	...overrides,
});

const componentRow = (
	overrides: Partial<{
		id: string;
		carId: string;
		slot: string;
		slotType: string;
		name: string;
		manufacturer: string | null;
		model: string | null;
		serialNumber: string | null;
		notes: string | null;
		installedAt: string;
		removedAt: string | null;
	}> = {},
) => ({
	id: 'component-1',
	carId: 'car-1',
	slot: 'motor',
	slotType: 'standard',
	name: 'Stock motor',
	manufacturer: null,
	model: null,
	serialNumber: null,
	notes: null,
	installedAt: '2026-01-01T00:00:00.000Z',
	removedAt: null,
	...overrides,
});

const jsonRequest = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

let currentD1: MockD1Controller | undefined;

afterEach(() => {
	currentD1?.expectConsumed();
	currentD1 = undefined;
});

const fixture = () => {
	const value = createHonoFixture();
	currentD1 = value.d1;
	return value;
};

describe('car routes', () => {
	test.each([
		['active', '', false],
		['archived', '?archived=true', true],
		['all', '?archived=all', true],
	] as const)('lists %s cars', async (_label, query, archived) => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'all', rows: [carRow()] });

		const response = await request(`/api/v1/cars${query}`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			cars: [
				{
					id: 'car-1',
					name: 'Race buggy',
					make: null,
					model: null,
					scale: '1/10',
					vehicleType: 'buggy',
					powerType: 'electric',
					notes: null,
					currentSetupId: null,
					createdAt: '2026-01-01T00:00:00.000Z',
					archivedAt: null,
					version: 1,
				},
			],
			archived,
		});
	});

	test('rejects an invalid archived filter', async () => {
		const { request } = fixture();

		const response = await request('/api/v1/cars?archived=false');

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: 'archived must be true or all',
		});
	});

	test('returns only an owned car', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: carRow() });

		const response = await request('/api/v1/cars/car-1');

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			car: { id: 'car-1', name: 'Race buggy' },
		});
	});

	test('hides an unowned car behind the not-found contract', async () => {
		const { d1, request } = fixture();
		d1.queue({
			kind: 'first',
			value: carRow({ ownerId: 'another-owner' }),
		});

		const response = await request('/api/v1/cars/car-1');

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'Car not found' });
	});

	test('creates a car through D1 and returns the public representation', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'run' },
			{ kind: 'first', value: carRow({ make: 'Associated' }) },
		);

		const response = await request(
			'/api/v1/cars',
			jsonRequest('POST', {
				name: 'Race buggy',
				make: 'Associated',
				model: 'B7',
				scale: '1/10',
				vehicleType: 'buggy',
				powerType: 'electric',
				notes: 'Indoor setup',
			}),
		);

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			car: { name: 'Race buggy', make: 'Associated', version: 1 },
		});
		const insert = d1.queries.find((query) =>
			query.query.startsWith('insert into "car"'),
		);
		expect(insert?.query).toContain('"version"');
		expect(insert?.query).toContain('"last_operation_id"');
	});

	test('creates a car with only the required name', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'run' }, { kind: 'first', value: carRow() });

		const response = await request(
			'/api/v1/cars',
			jsonRequest('POST', { name: 'Race buggy' }),
		);

		expect(response.status).toBe(201);
	});

	test('rejects invalid car creation and update bodies', async () => {
		const { request } = fixture();

		for (const [path, method, body] of [
			['/api/v1/cars', 'POST', { name: '' }],
			['/api/v1/cars/car-1', 'PATCH', {}],
		] as const) {
			const response = await request(path, jsonRequest(method, body));
			expect(response.status).toBe(400);
		}
	});

	test('updates an owned car', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: carRow() },
			{
				kind: 'first',
				value: carRow({
					name: 'Updated buggy',
					version: 2,
					lastOperationId: 'private-operation',
				}),
			},
		);

		const response = await request(
			'/api/v1/cars/car-1',
			jsonRequest('PATCH', { name: 'Updated buggy' }),
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			car: { id: 'car-1', name: 'Updated buggy', version: 2 },
		});
		expect(body).not.toHaveProperty('car.lastOperationId');
		const update = d1.queries.find((query) =>
			query.query.startsWith('update "car"'),
		);
		expect(update?.query).toContain('"version" = ?');
		expect(update?.query).toContain('"last_operation_id" = ?');
	});

	test('rejects a concurrent legacy car update instead of overwriting it', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: null },
		);

		const response = await request(
			'/api/v1/cars/car-1',
			jsonRequest('PATCH', { name: 'Stale update' }),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: 'Car changed; reload and try again',
		});
	});

	test('does not update a missing car', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: null });

		const response = await request(
			'/api/v1/cars/missing',
			jsonRequest('PATCH', { name: 'Updated buggy' }),
		);

		expect(response.status).toBe(404);
	});

	test.each([
		['archive', null, '2026-02-01T00:00:00.000Z'],
		['restore', '2026-01-01T00:00:00.000Z', null],
	] as const)(
		'%s transitions an owned car and its plans',
		async (action, before, after) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: carRow({ archivedAt: before }) },
				{ kind: 'batch', rows: [[{ id: 'car-1' }], []] },
				{
					kind: 'first',
					value: carRow({
						archivedAt: after,
						version: 2,
						lastOperationId: 'private-operation',
					}),
				},
			);

			const response = await request(`/api/v1/cars/car-1/${action}`, {
				method: 'POST',
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				car: { id: 'car-1', archivedAt: after, version: 2 },
			});
			expect(d1.batches[0]?.[0]).toContain('"version" = ?');
			expect(d1.batches[0]?.[0]).toContain('"last_operation_id" = ?');
		},
	);

	test.each(['archive', 'restore'] as const)(
		'rejects a concurrent legacy %s transition without changing plans',
		async (action) => {
			const before = action === 'archive' ? null : '2026-01-01T00:00:00.000Z';
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: carRow({ archivedAt: before }) },
				{ kind: 'batch', rows: [[], []] },
			);

			const response = await request(`/api/v1/cars/car-1/${action}`, {
				method: 'POST',
			});

			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({
				error: 'Car changed; reload and try again',
			});
			expect(d1.batches[0]?.[1]).toContain('exists (select');
		},
	);

	test.each([
		['archive', '2026-01-01T00:00:00.000Z', 'Car is already archived'],
		['restore', null, 'Car is already active'],
	] as const)(
		'rejects an invalid %s transition',
		async (action, archivedAt, error) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: carRow({ archivedAt }) });

			const response = await request(`/api/v1/cars/car-1/${action}`, {
				method: 'POST',
			});

			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error });
		},
	);

	test.each(['archive', 'restore'] as const)(
		'%s hides a missing car',
		async (action) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: null });

			const response = await request(`/api/v1/cars/missing/${action}`, {
				method: 'POST',
			});

			expect(response.status).toBe(404);
		},
	);

	test('lists standard component slots', async () => {
		const { request } = fixture();

		const response = await request('/api/v1/component-slots');

		expect(response.status).toBe(200);
		const body = (await response.json()) as { standard: string[] };
		expect(body.standard).toContain('motor');
	});

	test.each([
		['current', '', false],
		['history', '?history=true', true],
	] as const)(
		'lists %s components for an owned car',
		async (_label, query, history) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: carRow() },
				{ kind: 'all', rows: [componentRow()] },
			);

			const response = await request(`/api/v1/cars/car-1/components${query}`);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				components: [componentRow()],
				history,
			});
		},
	);

	test('returns a component owned through its car', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: componentRow() },
		);

		const response = await request('/api/v1/cars/car-1/components/component-1');

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ component: componentRow() });
	});

	test('hides component collections and records when ownership fails', async () => {
		for (const path of [
			'/api/v1/cars/missing/components',
			'/api/v1/cars/missing/components/component-1',
		]) {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: null });
			const response = await request(path);
			expect(response.status).toBe(404);
			d1.expectConsumed();
			currentD1 = undefined;
		}
	});

	test('returns 404 when an owned car does not have the requested component', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: null },
		);

		const response = await request('/api/v1/cars/car-1/components/missing');

		expect(response.status).toBe(404);
	});

	test('installs a component and carries maintenance plans forward', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: componentRow() },
			{ kind: 'all', rows: [{ id: 'drive-1' }] },
			{ kind: 'batch' },
			{
				kind: 'first',
				value: componentRow({ id: 'component-new', name: 'Modified motor' }),
			},
		);

		const response = await request(
			'/api/v1/cars/car-1/components',
			jsonRequest('POST', {
				slot: 'Motor',
				slotType: 'standard',
				name: 'Modified motor',
				manufacturer: 'Reedy',
				model: 'S-Plus',
				serialNumber: '123',
				notes: 'Installed for race',
				installedAt: '2026-02-01T00:00:00.000Z',
			}),
		);

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			component: { name: 'Modified motor' },
		});
	});

	test('installs a first custom-slot component without a prior plan', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: null },
			{ kind: 'all', rows: [] },
			{ kind: 'batch' },
			{
				kind: 'first',
				value: componentRow({ slot: 'transponder', slotType: 'custom' }),
			},
		);

		const response = await request(
			'/api/v1/cars/car-1/components',
			jsonRequest('POST', { slot: ' transponder ', name: 'AMB' }),
		);

		expect(response.status).toBe(201);
	});

	test('carries plans forward using the install time by default', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: componentRow() },
			{ kind: 'all', rows: [] },
			{ kind: 'batch' },
			{ kind: 'first', value: componentRow({ id: 'component-new' }) },
		);

		const response = await request(
			'/api/v1/cars/car-1/components',
			jsonRequest('POST', { slot: 'motor', name: 'Replacement' }),
		);

		expect(response.status).toBe(201);
	});

	test.each([
		['invalid body', { slot: '', name: '' }, null, 400],
		['missing car', { slot: 'motor', name: 'Motor' }, null, 404],
		[
			'archived car',
			{ slot: 'motor', name: 'Motor' },
			carRow({ archivedAt: '2026-01-01T00:00:00.000Z' }),
			409,
		],
		[
			'mismatched slot type',
			{ slot: 'motor', slotType: 'custom', name: 'Motor' },
			carRow(),
			400,
		],
	] as const)(
		'rejects component creation for %s',
		async (_case, body, parent, status) => {
			const { d1, request } = fixture();
			if (_case !== 'invalid body') d1.queue({ kind: 'first', value: parent });

			const response = await request(
				'/api/v1/cars/car-1/components',
				jsonRequest('POST', body),
			);

			expect(response.status).toBe(status);
		},
	);

	test('updates a current component', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: componentRow() },
			{ kind: 'run' },
			{ kind: 'first', value: componentRow({ name: 'Updated motor' }) },
		);

		const response = await request(
			'/api/v1/cars/car-1/components/component-1',
			jsonRequest('PATCH', {
				name: 'Updated motor',
				manufacturer: 'Reedy',
				model: 'S-Plus',
				serialNumber: '456',
				notes: 'Updated notes',
				installedAt: '2026-02-01T00:00:00.000Z',
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			component: { name: 'Updated motor' },
		});
	});

	test.each([
		['invalid body', {}, [], 400],
		['missing car', { name: 'Updated' }, [null], 404],
		[
			'archived car',
			{ name: 'Updated' },
			[carRow({ archivedAt: '2026-01-01T00:00:00.000Z' })],
			409,
		],
		['missing component', { name: 'Updated' }, [carRow(), null], 404],
		[
			'historical component',
			{ name: 'Updated' },
			[carRow(), componentRow({ removedAt: '2026-01-01T00:00:00.000Z' })],
			409,
		],
	] as const)(
		'rejects component update for %s',
		async (_case, body, rows, status) => {
			const { d1, request } = fixture();
			for (const value of rows) d1.queue({ kind: 'first', value });

			const response = await request(
				'/api/v1/cars/car-1/components/component-1',
				jsonRequest('PATCH', body),
			);

			expect(response.status).toBe(status);
		},
	);

	test('replaces a current component in the same normalized slot', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: componentRow({ slot: 'Motor' }) },
			{ kind: 'all', rows: [] },
			{ kind: 'batch' },
			{ kind: 'first', value: componentRow({ name: 'Replacement' }) },
		);

		const response = await request(
			'/api/v1/cars/car-1/components/component-1/replace',
			jsonRequest('POST', { slot: 'motor', name: 'Replacement' }),
		);

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			previous: { id: 'component-1' },
			component: { name: 'Replacement' },
		});
	});

	test('replaces a current custom-slot component', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: carRow() },
			{
				kind: 'first',
				value: componentRow({ slot: ' transponder ', slotType: 'custom' }),
			},
			{ kind: 'all', rows: [] },
			{ kind: 'batch' },
			{ kind: 'first', value: componentRow({ name: 'Replacement' }) },
		);

		const response = await request(
			'/api/v1/cars/car-1/components/component-1/replace',
			jsonRequest('POST', { slot: 'transponder', name: 'Replacement' }),
		);

		expect(response.status).toBe(201);
	});

	test.each([
		['invalid body', { slot: '', name: '' }, [], 400],
		['missing car', { slot: 'motor', name: 'New' }, [null], 404],
		[
			'archived car',
			{ slot: 'motor', name: 'New' },
			[carRow({ archivedAt: '2026-01-01T00:00:00.000Z' })],
			409,
		],
		[
			'missing component',
			{ slot: 'motor', name: 'New' },
			[carRow(), null],
			404,
		],
		[
			'removed component',
			{ slot: 'motor', name: 'New' },
			[carRow(), componentRow({ removedAt: '2026-01-01T00:00:00.000Z' })],
			409,
		],
		[
			'invalid slot',
			{ slot: 'motor', slotType: 'custom', name: 'New' },
			[carRow(), componentRow()],
			400,
		],
		[
			'different slot',
			{ slot: 'battery', name: 'New' },
			[carRow(), componentRow()],
			400,
		],
	] as const)(
		'rejects component replacement for %s',
		async (_case, body, rows, status) => {
			const { d1, request } = fixture();
			for (const value of rows) d1.queue({ kind: 'first', value });

			const response = await request(
				'/api/v1/cars/car-1/components/component-1/replace',
				jsonRequest('POST', body),
			);

			expect(response.status).toBe(status);
		},
	);

	test('removes a current component and pauses its plans', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: carRow() },
			{ kind: 'first', value: componentRow() },
			{ kind: 'batch' },
		);

		const response = await request(
			'/api/v1/cars/car-1/components/component-1/remove',
			{ method: 'POST' },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			component: { id: 'component-1', removedAt: expect.any(String) },
		});
	});

	test.each([
		['missing car', [null], 404],
		['archived car', [carRow({ archivedAt: '2026-01-01T00:00:00.000Z' })], 409],
		['missing component', [carRow(), null], 404],
		[
			'removed component',
			[carRow(), componentRow({ removedAt: '2026-01-01T00:00:00.000Z' })],
			409,
		],
	] as const)(
		'rejects component removal for %s',
		async (_case, rows, status) => {
			const { d1, request } = fixture();
			for (const value of rows) d1.queue({ kind: 'first', value });

			const response = await request(
				'/api/v1/cars/car-1/components/component-1/remove',
				{ method: 'POST' },
			);

			expect(response.status).toBe(status);
		},
	);
});
