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
	currentSetupVersion: 0,
	currentSetupOperationId: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	archivedAt: null,
	version: 1,
	lastOperationId: null,
	...overrides,
});

const setup = (overrides: Record<string, unknown> = {}) => ({
	id: 'setup-1',
	carId: 'car-1',
	name: 'Baseline',
	status: 'active',
	setupDate: null,
	track: null,
	event: null,
	surface: null,
	traction: null,
	moisture: null,
	condition: null,
	temperature: null,
	vehicle: '{}',
	drivetrain: '{}',
	electronics: '{}',
	tires: '{}',
	shocks: '{}',
	frontSuspension: '{}',
	rearSuspension: '{}',
	notes: null,
	sourceUrl: null,
	sourcePdfReference: null,
	sourceMetadata: null,
	copiedFromId: null,
	rawValues: null,
	unmappedValues: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	version: 1,
	lastOperationId: null,
	...overrides,
});

const draft = (overrides: Record<string, unknown> = {}) => ({
	id: 'draft-1',
	ownerId: 'owner-1',
	carId: 'car-1',
	sourceUrl: 'https://www.sodialed.com/setup/example',
	sourceKey: 'https://www.sodialed.com/setup/example',
	status: 'draft',
	sourceIdentity: '{"title":"Imported baseline"}',
	sourcePdfReference: null,
	sourceMetadata: '{}',
	knownValues: '{"track":"Clay"}',
	uncertainValues: '{}',
	rawValues: '{}',
	unmappedValues: '{}',
	error: null,
	acceptedSetupId: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	...overrides,
});

const json = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

let current: MockD1Controller | undefined;
const fixture = () => {
	const value = createHonoFixture();
	current = value.d1;
	return value;
};

afterEach(() => {
	current?.expectConsumed();
	current = undefined;
	vi.unstubAllGlobals();
});

describe('setup routes', () => {
	test('lists the complete owner-scoped setup snapshot without per-car requests', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{
				kind: 'all',
				rows: [
					car({ currentSetupId: 'setup-1', currentSetupVersion: 3 }),
					car({ id: 'car-2', name: 'Truggy' }),
				],
			},
			{
				kind: 'all',
				rows: [setup(), setup({ id: 'setup-2', name: 'Wet track' })],
			},
		);

		const response = await request('/api/v1/setups');

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			setupCollections: [
				{
					carId: 'car-1',
					currentSetupId: 'setup-1',
					currentSetupVersion: 3,
					setups: [
						{ id: 'setup-1', current: true },
						{ id: 'setup-2', current: false },
					],
				},
				{
					carId: 'car-2',
					currentSetupId: null,
					currentSetupVersion: 0,
					setups: [],
				},
			],
		});
	});

	test('returns a null current setup when the car has no selection', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: car() });

		const response = await request('/api/v1/cars/car-1/setups/current');

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ setup: null });
	});

	test('returns the selected current setup', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'first', value: setup() },
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
		);

		const response = await request('/api/v1/cars/car-1/setups/current');

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			setup: { id: 'setup-1', current: true },
		});
	});

	test('returns null when a selected current setup is stale', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car({ currentSetupId: 'missing' }) },
			{ kind: 'first', value: null },
		);

		const response = await request('/api/v1/cars/car-1/setups/current');

		expect(await response.json()).toEqual({ setup: null });
	});

	test.each([
		'/api/v1/cars/missing/setups/current',
		'/api/v1/cars/missing/setups',
	])('hides setup collections for a missing car at %s', async (path) => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: null });
		const response = await request(path);
		expect(response.status).toBe(404);
	});

	test('lists setup snapshots and marks the current one', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'all', rows: [setup()] },
		);

		const response = await request('/api/v1/cars/car-1/setups');

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			currentSetupId: 'setup-1',
			setups: [{ id: 'setup-1', current: true }],
		});
	});

	test.each([false, true])(
		'creates a setup with makeCurrent=%s',
		async (makeCurrent) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'batch' },
				{ kind: 'first', value: setup({ name: 'New setup' }) },
			);

			const response = await request(
				'/api/v1/cars/car-1/setups',
				json('POST', {
					name: 'New setup',
					status: 'active',
					setupDate: '2026-02-01T00:00:00.000Z',
					track: 'Clay',
					event: 'Club race',
					surface: 'dirt',
					traction: 'high',
					moisture: 'dry',
					condition: 'smooth',
					temperature: '72F',
					vehicle: {},
					drivetrain: {},
					electronics: {},
					tires: {},
					shocks: {},
					frontSuspension: {},
					rearSuspension: {},
					notes: 'Notes',
					sourceUrl: 'https://example.com',
					sourcePdfReference: 'sheet.pdf',
					sourceMetadata: {},
					rawValues: {},
					unmappedValues: {},
					makeCurrent,
				}),
			);

			expect(response.status).toBe(201);
			expect(await response.json()).toMatchObject({
				setup: { name: 'New setup', current: makeCurrent },
			});
			expect(d1.batches[0]).toHaveLength(makeCurrent ? 2 : 1);
			if (makeCurrent) {
				expect(d1.batches[0]?.[1]).toContain('"current_setup_version"');
				expect(d1.batches[0]?.[1]).toContain('"current_setup_operation_id"');
			}
		},
	);

	test.each([
		['missing car', null, { name: 'Setup' }, 404],
		[
			'archived car',
			car({ archivedAt: '2026-01-01T00:00:00.000Z' }),
			{ name: 'Setup' },
			409,
		],
		['invalid body', car(), { name: '' }, 400],
	] as const)(
		'rejects setup creation for %s',
		async (_case, parent, body, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: parent });
			const response = await request(
				'/api/v1/cars/car-1/setups',
				json('POST', body),
			);
			expect(response.status).toBe(status);
		},
	);

	test('gets an owned setup and reports whether it is current', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: setup() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
		);
		const response = await request('/api/v1/cars/car-1/setups/setup-1');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			setup: { id: 'setup-1', current: true },
		});
	});

	test('returns 404 for an unowned setup', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: null });
		const response = await request('/api/v1/cars/car-1/setups/missing');
		expect(response.status).toBe(404);
	});

	test.each([false, true])(
		'copies the best setup with makeCurrent=%s',
		async (makeCurrent) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
				{ kind: 'all', rows: [setup()] },
				{ kind: 'batch' },
				{
					kind: 'first',
					value: setup({ id: 'setup-copy', copiedFromId: 'setup-1' }),
				},
			);
			const response = await request(
				'/api/v1/cars/car-1/setups/copy',
				json('POST', { name: 'Copied setup', makeCurrent }),
			);
			expect(response.status).toBe(201);
			expect(await response.json()).toMatchObject({ sourceSetupId: 'setup-1' });
			expect(d1.batches[0]).toHaveLength(makeCurrent ? 2 : 1);
			if (makeCurrent)
				expect(d1.batches[0]?.[1]).toContain('"current_setup_version"');
		},
	);

	test('reports when there is no setup to copy', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: car() }, { kind: 'all', rows: [] });
		const response = await request(
			'/api/v1/cars/car-1/setups/copy',
			json('POST', {}),
		);
		expect(response.status).toBe(404);
	});

	test.each([
		['missing car', null, {}, 404],
		['archived car', car({ archivedAt: '2026-01-01T00:00:00.000Z' }), {}, 409],
		['invalid copy', car(), { name: '' }, 400],
	] as const)(
		'rejects copy-forward for %s',
		async (_case, parent, body, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: parent });
			const response = await request(
				'/api/v1/cars/car-1/setups/copy',
				json('POST', body),
			);
			expect(response.status).toBe(status);
		},
	);

	test('updates every mutable setup section', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'first', value: setup() },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'first', value: setup({ name: 'Updated' }) },
			{ kind: 'first', value: car() },
		);
		const response = await request(
			'/api/v1/cars/car-1/setups/setup-1',
			json('PATCH', {
				name: 'Updated',
				setupDate: '2026-02-01T00:00:00.000Z',
				track: 'Clay',
				event: 'Race',
				surface: 'dirt',
				traction: 'high',
				moisture: 'dry',
				condition: 'smooth',
				temperature: '72',
				vehicle: {},
				drivetrain: {},
				electronics: {},
				tires: {},
				shocks: {},
				frontSuspension: {},
				rearSuspension: {},
				notes: 'Notes',
				sourceUrl: 'https://example.com',
				sourcePdfReference: 'sheet',
				sourceMetadata: {},
				rawValues: {},
				unmappedValues: {},
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ setup: { name: 'Updated' } });
		const update = d1.queries.find(
			(query) =>
				query.operation === 'run' && query.query.includes('update "setup"'),
		);
		expect(update?.query).toContain('"version"');
		expect(update?.query).toContain('"last_operation_id"');
	});

	test.each([{ name: 'Name only' }, { setupDate: null }])(
		'updates setup date fallback shape $name$setupDate',
		async (body) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'first', value: setup() },
				{ kind: 'first', value: car() },
				{ kind: 'run' },
				{ kind: 'first', value: setup() },
				{ kind: 'first', value: car() },
			);
			expect(
				(
					await request(
						'/api/v1/cars/car-1/setups/setup-1',
						json('PATCH', body),
					)
				).status,
			).toBe(200);
		},
	);

	test('copies a specifically requested setup and can select it current', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: setup() },
			{ kind: 'first', value: car() },
			{ kind: 'batch' },
			{ kind: 'first', value: setup({ id: 'setup-copy' }) },
		);
		const response = await request(
			'/api/v1/cars/car-1/setups/setup-1/copy',
			json('POST', { makeCurrent: true }),
		);
		expect(response.status).toBe(201);
	});

	test('atomically copies the expected unchanged Current setup', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'first', value: setup() },
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'batch' },
			{ kind: 'first', value: setup({ id: 'setup-copy' }) },
		);
		const response = await request(
			'/api/v1/cars/car-1/setups/setup-1/copy',
			json('POST', {
				name: 'Changed setup',
				makeCurrent: true,
				expectedCurrentSetupId: 'setup-1',
				expectedSourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			}),
		);

		expect(response.status).toBe(201);
		expect(d1.batches.at(-1)?.[0]).toContain(
			'inner join "setup" "guarded_source"',
		);
		expect(d1.batches.at(-1)?.[0]).toContain(
			'"guarded_source"."updated_at" = ?',
		);
		expect(d1.batches.at(-1)?.[1]).toContain('exists (select');
		expect(d1.batches.at(-1)?.[1]).toContain('"current_setup_version"');
	});

	test('rejects a stale guarded Current setup without creating a copy', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'first', value: setup() },
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'batch' },
			{ kind: 'first', value: null },
		);
		const response = await request(
			'/api/v1/cars/car-1/setups/setup-1/copy',
			json('POST', {
				makeCurrent: true,
				expectedCurrentSetupId: 'setup-1',
				expectedSourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			}),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: 'The Current setup changed while you were editing',
		});
	});

	test.each([
		[
			'mismatched Current setup',
			{
				makeCurrent: true,
				expectedCurrentSetupId: 'setup-2',
				expectedSourceUpdatedAt: '2026-01-01T00:00:00.000Z',
			},
			409,
		],
		[
			'incomplete stale-write precondition',
			{ makeCurrent: true, expectedCurrentSetupId: 'setup-1' },
			400,
		],
	] as const)(
		'rejects %s for a requested setup copy',
		async (_case, body, status) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
				{ kind: 'first', value: setup() },
				{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			);
			const response = await request(
				'/api/v1/cars/car-1/setups/setup-1/copy',
				json('POST', body),
			);
			expect(response.status).toBe(status);
		},
	);

	test('selects an owned setup as current', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: setup() },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
		);
		const response = await request(
			'/api/v1/cars/car-1/setups/setup-1/current',
			{ method: 'POST' },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ setup: { current: true } });
		expect(
			d1.queries.find((query) => query.operation === 'run')?.query,
		).toContain('"current_setup_version"');
	});

	test('keeps the Current setup version unchanged when selecting it again', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'first', value: setup() },
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
		);

		const response = await request(
			'/api/v1/cars/car-1/setups/setup-1/current',
			{ method: 'POST' },
		);

		expect(response.status).toBe(200);
		expect(d1.queries.some((query) => query.operation === 'run')).toBe(false);
	});

	test.each([
		['patch', 'PATCH', { name: 'Updated' }],
		['copy', 'POST', {}],
		['current', 'POST', undefined],
	] as const)(
		'rejects %s when the parent car is missing',
		async (suffix, method, body) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: null });
			const response = await request(
				`/api/v1/cars/missing/setups/setup-1${suffix === 'patch' ? '' : `/${suffix}`}`,
				body === undefined ? { method } : json(method, body),
			);
			expect(response.status).toBe(404);
		},
	);

	test.each([
		['', 'PATCH', { name: 'Updated' }],
		['/copy', 'POST', {}],
		['/current', 'POST', undefined],
	] as const)(
		'rejects %s setup mutation for an archived car',
		async (suffix, method, body) => {
			const { d1, request } = fixture();
			d1.queue({
				kind: 'first',
				value: car({ archivedAt: '2026-01-01T00:00:00.000Z' }),
			});
			const init = body === undefined ? { method } : json(method, body);
			expect(
				(await request(`/api/v1/cars/car-1/setups/setup-1${suffix}`, init))
					.status,
			).toBe(409);
		},
	);

	test.each([
		['', 'PATCH', { name: 'Updated' }],
		['/copy', 'POST', {}],
		['/current', 'POST', undefined],
	] as const)(
		'returns 404 when the setup for %s is missing',
		async (suffix, method, body) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: car() }, { kind: 'first', value: null });
			const init = body === undefined ? { method } : json(method, body);
			expect(
				(await request(`/api/v1/cars/car-1/setups/missing${suffix}`, init))
					.status,
			).toBe(404);
		},
	);

	test.each([
		['', 'PATCH'],
		['/copy', 'POST'],
	] as const)(
		'rejects an invalid body for setup %s',
		async (suffix, method) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'first', value: setup() },
				{ kind: 'first', value: car() },
			);
			expect(
				(
					await request(
						`/api/v1/cars/car-1/setups/setup-1${suffix}`,
						json(method, { name: '' }),
					)
				).status,
			).toBe(400);
		},
	);

	test.each([
		'/api/v1/cars/car-1/setups/copy',
		'/api/v1/cars/car-1/setups/setup-1/copy',
	] as const)(
		'treats malformed optional copy JSON as an empty request at %s',
		async (path) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: car() });
			if (path.endsWith('/setup-1/copy'))
				d1.queue(
					{ kind: 'first', value: setup() },
					{ kind: 'first', value: car() },
				);
			else d1.queue({ kind: 'all', rows: [setup()] });
			d1.queue(
				{ kind: 'batch' },
				{ kind: 'first', value: setup({ id: 'copy' }) },
			);
			const response = await request(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{',
			});
			expect(response.status).toBe(201);
		},
	);
});

describe('setup import routes', () => {
	const sourceUrl = 'https://www.sodialed.com/setup/example';
	const sourceResponse = () => {
		const response = new Response(
			'<meta property="og:title" content="Imported setup"><meta property="og:description" content="Clay">',
			{ status: 200, headers: { 'content-type': 'text/html' } },
		);
		Object.defineProperty(response, 'url', { value: sourceUrl });
		return response;
	};

	test('creates an import draft from a fetched So Dialed page', async () => {
		const { d1, request } = fixture();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => sourceResponse()),
		);
		d1.queue(
			{ kind: 'all', rows: [] },
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{ kind: 'first', value: draft() },
		);

		const response = await request(
			'/api/v1/setup-imports/drafts',
			json('POST', { sourceUrl }),
		);

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ draft: { id: 'draft-1' } });
	});

	test('continues past an imported setup owned by another user', async () => {
		const { d1, request } = fixture();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => sourceResponse()),
		);
		d1.queue(
			{ kind: 'all', rows: [setup({ carId: 'foreign-car' })] },
			{ kind: 'first', value: null },
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{ kind: 'first', value: draft() },
		);

		expect(
			(
				await request(
					'/api/v1/setup-imports/drafts',
					json('POST', { sourceUrl }),
				)
			).status,
		).toBe(201);
	});

	test('persists a reviewable error draft when the source cannot be fetched', async () => {
		const { d1, request } = fixture();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('offline');
			}),
		);
		d1.queue(
			{ kind: 'all', rows: [] },
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{ kind: 'first', value: draft({ status: 'error', error: 'offline' }) },
		);

		const response = await request(
			'/api/v1/setup-imports/drafts',
			json('POST', { sourceUrl }),
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({ error: 'offline' });
	});

	test('normalizes a non-Error source failure', async () => {
		const { d1, request } = fixture();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw 'offline';
			}),
		);
		d1.queue(
			{ kind: 'all', rows: [] },
			{ kind: 'first', value: null },
			{ kind: 'run' },
			{
				kind: 'first',
				value: draft({ status: 'error', error: 'Source unavailable' }),
			},
		);

		expect(
			(
				await request(
					'/api/v1/setup-imports/drafts',
					json('POST', { sourceUrl }),
				)
			).status,
		).toBe(422);
	});

	test('returns the concurrent draft after a unique insert race', async () => {
		const { d1, request } = fixture();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => sourceResponse()),
		);
		d1.queue(
			{ kind: 'all', rows: [] },
			{ kind: 'first', value: null },
			{ kind: 'error', error: new Error('UNIQUE constraint failed') },
			{ kind: 'first', value: draft() },
		);

		const response = await request(
			'/api/v1/setup-imports/drafts',
			json('POST', { sourceUrl }),
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ draft: { id: 'draft-1' } });
	});

	test('returns a null concurrent draft when a unique winner is not visible', async () => {
		const { d1, request } = fixture();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => sourceResponse()),
		);
		d1.queue(
			{ kind: 'all', rows: [] },
			{ kind: 'first', value: null },
			{ kind: 'error', error: new Error('UNIQUE constraint failed') },
			{ kind: 'first', value: null },
		);

		const response = await request(
			'/api/v1/setup-imports/drafts',
			json('POST', { sourceUrl }),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ draft: null });
	});

	test('does not misclassify a non-unique import persistence failure', async () => {
		const { d1, request } = fixture();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => sourceResponse()),
		);
		d1.queue(
			{ kind: 'all', rows: [] },
			{ kind: 'first', value: null },
			{ kind: 'error', error: new Error('database unavailable') },
		);
		const response = await request(
			'/api/v1/setup-imports/drafts',
			json('POST', { sourceUrl }),
		);
		expect(response.status).toBe(500);
	});

	test.each([
		['an imported setup', [setup(), car(), null]],
		['an open draft', [null, draft()]],
	] as const)('rejects a source that already has %s', async (_case, rows) => {
		const { d1, request } = fixture();
		if (_case === 'an imported setup') {
			d1.queue(
				{ kind: 'all', rows: [rows[0] as Record<string, unknown>] },
				{ kind: 'first', value: rows[1] as Record<string, unknown> },
				{ kind: 'first', value: null },
			);
		} else {
			d1.queue(
				{ kind: 'all', rows: [] },
				{ kind: 'first', value: rows[1] as Record<string, unknown> },
			);
		}
		const response = await request(
			'/api/v1/setup-imports/drafts',
			json('POST', { sourceUrl }),
		);
		expect(response.status).toBe(409);
	});

	test('lists and gets owned import drafts', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'all', rows: [draft()] });
		const list = await request('/api/v1/setup-imports/drafts');
		expect(list.status).toBe(200);
		expect(await list.json()).toMatchObject({ drafts: [{ id: 'draft-1' }] });
		d1.queue({ kind: 'first', value: draft() });
		const one = await request('/api/v1/setup-imports/drafts/draft-1');
		expect(one.status).toBe(200);
	});

	test('returns 404 for a missing import draft', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: null });
		const response = await request('/api/v1/setup-imports/drafts/missing');
		expect(response.status).toBe(404);
	});

	test.each([
		'/api/v1/setup-imports/drafts/missing/cancel',
		'/api/v1/setup-imports/drafts/missing/accept',
	] as const)('returns 404 for a missing draft action at %s', async (path) => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: null });
		expect((await request(path, { method: 'POST' })).status).toBe(404);
	});

	test('updates an open import draft', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: draft() },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'first', value: draft({ knownValues: '{"track":"Dirt"}' }) },
		);
		const response = await request(
			'/api/v1/setup-imports/drafts/draft-1',
			json('PATCH', {
				carId: 'car-1',
				knownValues: { track: 'Dirt' },
				uncertainValues: {},
				rawValues: {},
				unmappedValues: {},
				sourceMetadata: {},
			}),
		);
		expect(response.status).toBe(200);
	});

	test('updates draft values without changing its car assignment', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: draft() },
			{ kind: 'run' },
			{ kind: 'first', value: draft({ knownValues: '{"track":"Dirt"}' }) },
		);
		expect(
			(
				await request(
					'/api/v1/setup-imports/drafts/draft-1',
					json('PATCH', { knownValues: { track: 'Dirt' } }),
				)
			).status,
		).toBe(200);
	});

	test.each([
		['missing', null, { knownValues: {} }, 404],
		['closed', draft({ status: 'accepted' }), { knownValues: {} }, 409],
		['invalid', draft(), {}, 400],
	] as const)(
		'rejects draft update when %s',
		async (_case, value, body, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value });
			const response = await request(
				'/api/v1/setup-imports/drafts/draft-1',
				json('PATCH', body),
			);
			expect(response.status).toBe(status);
		},
	);

	test('rejects moving an import draft to a missing car', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: draft() }, { kind: 'first', value: null });
		const response = await request(
			'/api/v1/setup-imports/drafts/draft-1',
			json('PATCH', { carId: 'missing' }),
		);
		expect(response.status).toBe(404);
	});

	test.each(['draft', 'error'] as const)(
		'cancels an import in %s state',
		async (status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: draft({ status }) }, { kind: 'run' });
			const response = await request(
				'/api/v1/setup-imports/drafts/draft-1/cancel',
				{ method: 'POST' },
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true });
		},
	);

	test('rejects cancellation of a closed import', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: draft({ status: 'accepted' }) });
		const response = await request(
			'/api/v1/setup-imports/drafts/draft-1/cancel',
			{ method: 'POST' },
		);
		expect(response.status).toBe(409);
	});

	test.each([false, true])(
		'accepts a reviewed import with makeCurrent=%s',
		async (makeCurrent) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: draft() },
				{ kind: 'first', value: car() },
				{ kind: 'all', rows: [] },
				{ kind: 'batch' },
				{ kind: 'first', value: setup({ name: 'Accepted import' }) },
			);
			const response = await request(
				'/api/v1/setup-imports/drafts/draft-1/accept',
				json('POST', { carId: 'car-1', name: 'Accepted import', makeCurrent }),
			);
			expect(response.status).toBe(201);
			expect(await response.json()).toMatchObject({
				setup: { current: makeCurrent },
			});
			expect(d1.batches[0]).toHaveLength(makeCurrent ? 3 : 2);
			if (makeCurrent)
				expect(d1.batches[0]?.[2]).toContain('"current_setup_version"');
		},
	);

	test.each([
		['missing', null, { carId: 'car-1' }, 404],
		['closed', draft({ status: 'accepted' }), { carId: 'car-1' }, 409],
		['invalid body', draft(), {}, 400],
	] as const)(
		'rejects import acceptance when %s',
		async (_case, value, body, status) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value });
			const response = await request(
				'/api/v1/setup-imports/drafts/draft-1/accept',
				json('POST', body),
			);
			expect(response.status).toBe(status);
		},
	);

	test('rejects acceptance for an archived car', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: draft() },
			{
				kind: 'first',
				value: car({ archivedAt: '2026-01-01T00:00:00.000Z' }),
			},
		);
		const response = await request(
			'/api/v1/setup-imports/drafts/draft-1/accept',
			json('POST', { carId: 'car-1' }),
		);
		expect(response.status).toBe(409);
	});

	test('rejects acceptance for a missing car', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: draft() }, { kind: 'first', value: null });
		expect(
			(
				await request(
					'/api/v1/setup-imports/drafts/draft-1/accept',
					json('POST', { carId: 'missing' }),
				)
			).status,
		).toBe(404);
	});

	test('uses the minimal reviewed snapshot when stored import fields are invalid', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{
				kind: 'first',
				value: draft({
					sourceUrl: 'invalid-source',
					sourceIdentity: '{}',
					sourceMetadata: null,
					knownValues: '{"name":""}',
				}),
			},
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [] },
			{ kind: 'batch' },
			{ kind: 'first', value: setup({ name: 'Imported setup' }) },
		);
		expect(
			(
				await request(
					'/api/v1/setup-imports/drafts/draft-1/accept',
					json('POST', { carId: 'car-1' }),
				)
			).status,
		).toBe(201);
	});

	test.each([
		draft(),
		draft({
			sourceIdentity: null,
			sourceMetadata: null,
			knownValues: null,
			uncertainValues: null,
			rawValues: null,
			unmappedValues: null,
		}),
	])(
		'accepts import fallback data shapes through review',
		async (storedDraft) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: storedDraft },
				{ kind: 'first', value: car() },
				{ kind: 'all', rows: [] },
				{ kind: 'batch' },
				{ kind: 'first', value: setup({ name: 'Imported setup' }) },
			);
			expect(
				(
					await request(
						'/api/v1/setup-imports/drafts/draft-1/accept',
						json('POST', { carId: 'car-1' }),
					)
				).status,
			).toBe(201);
		},
	);

	test('rejects acceptance when the source has already been imported', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: draft() },
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [setup()] },
			{ kind: 'first', value: car() },
		);
		const response = await request(
			'/api/v1/setup-imports/drafts/draft-1/accept',
			json('POST', { carId: 'car-1' }),
		);
		expect(response.status).toBe(409);
	});

	test('rejects unsupported import URLs before fetching', async () => {
		const { request } = fixture();
		const response = await request(
			'/api/v1/setup-imports/drafts',
			json('POST', { sourceUrl: 'https://example.com/setup' }),
		);
		expect(response.status).toBe(400);
	});

	test('rejects an import assigned to a missing car', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: null });
		const response = await request(
			'/api/v1/setup-imports/drafts',
			json('POST', {
				sourceUrl: 'https://www.sodialed.com/setup/example',
				carId: 'missing',
			}),
		);
		expect(response.status).toBe(404);
	});

	test('rejects a stale current setup creation without inserting an orphan', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'batch', changes: [0, 0] },
		);
		const response = await request(
			'/api/v1/cars/car-1/setups',
			json('POST', { name: 'Stale', makeCurrent: true }),
		);
		expect(response.status).toBe(409);
	});

	test('rejects stale import acceptance without saving its setup', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: draft() },
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [] },
			{ kind: 'batch', changes: [0, 1, 0] },
		);
		const response = await request(
			'/api/v1/setup-imports/drafts/draft-1/accept',
			json('POST', { carId: 'car-1', makeCurrent: true }),
		);
		expect(response.status).toBe(409);
	});

	test('rejects a stale current setup copy', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'all', rows: [setup()] },
			{ kind: 'batch', changes: [0, 0] },
		);
		const response = await request(
			'/api/v1/cars/car-1/setups/copy',
			json('POST', { makeCurrent: true }),
		);
		expect(response.status).toBe(409);
	});

	test('rejects a stale setup correction and current selection', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'first', value: setup() },
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'run', changes: 0 },
		);
		expect(
			(
				await request(
					'/api/v1/cars/car-1/setups/setup-1',
					json('PATCH', { name: 'Changed' }),
				)
			).status,
		).toBe(409);

		const second = fixture();
		second.d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: setup() },
			{ kind: 'first', value: car() },
			{ kind: 'run', changes: 0 },
		);
		expect(
			(
				await second.request(
					'/api/v1/cars/car-1/setups/setup-1/current',
					json('POST', {}),
				)
			).status,
		).toBe(409);
	});
});
