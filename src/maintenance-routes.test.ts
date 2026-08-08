import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	createHonoFixture,
	type MockD1Controller,
} from './testing/hono-fixture';

const car = (o: Record<string, unknown> = {}) => ({
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
	...o,
});

describe('maintenance coverage closeouts', () => {
	test('covers missing reads, archived canonical edits, and malformed compatibility JSON', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: null });
		expect((await request('/api/v1/consumables/missing')).status).toBe(404);
		d1.queue(
			{ kind: 'first', value: consumable() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car({ archivedAt: 'x' }) },
		);
		expect(
			(
				await request(
					'/api/v1/consumables/consumable-1',
					json('PATCH', { notes: 'x' }),
				)
			).status,
		).toBe(409);
		d1.queue(
			{ kind: 'first', value: consumable() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'first', value: consumable() },
			{ kind: 'first', value: car() },
		);
		expect(
			(
				await request(
					'/api/v1/cars/car-1/consumable-maintenance/consumable-1',
					{
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: '{',
					},
				)
			).status,
		).toBe(200);
	});

	test.each(['PATCH', 'DELETE'] as const)(
		'rejects %s drive mutation when the car is missing',
		async (method) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: null });
			const init =
				method === 'PATCH' ? json(method, { notes: 'x' }) : { method };
			expect(
				(await request('/api/v1/cars/missing/drives/drive-1', init)).status,
			).toBe(404);
		},
	);

	test('rejects completion on an archived car', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: plan() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car({ archivedAt: 'x' }) },
		);
		expect(
			(
				await request(
					'/api/v1/maintenance-plans/plan-1/complete',
					json('POST', {}),
				)
			).status,
		).toBe(409);
	});

	test('fails closed for an already inconsistent persisted service cost pair', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: record({ cost: 1, currency: null }) },
			{ kind: 'first', value: car() },
		);
		expect(
			(
				await request(
					'/api/v1/service-records/record-1',
					json('PATCH', { notes: 'x' }),
				)
			).status,
		).toBe(400);
	});
});
const setup = (o: Record<string, unknown> = {}) => ({
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
	vehicle: null,
	drivetrain: null,
	electronics: null,
	tires: '{"front":{"compound":"A"},"rear":{"compound":"B"}}',
	shocks: null,
	frontSuspension: null,
	rearSuspension: null,
	notes: null,
	sourceUrl: null,
	sourcePdfReference: null,
	sourceMetadata: null,
	copiedFromId: null,
	rawValues: null,
	unmappedValues: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	...o,
});
const consumable = (o: Record<string, unknown> = {}) => ({
	id: 'consumable-1',
	carId: 'car-1',
	kind: 'tires',
	performedAt: '2026-01-01T00:00:00.000Z',
	fluidArea: null,
	customFluidArea: null,
	frontDetails: '{"details":{"compound":"A"}}',
	frontCost: 10,
	frontCurrency: 'USD',
	rearDetails: null,
	rearCost: null,
	rearCurrency: null,
	cost: null,
	currency: null,
	notes: null,
	prefilledFromSetupId: null,
	archivedAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	...o,
});
const drive = (o: Record<string, unknown> = {}) => ({
	id: 'drive-1',
	carId: 'car-1',
	startedAt: '2026-01-01T20:00:00.000Z',
	durationMinutes: 10,
	conditions: 'dry',
	notes: null,
	deletedAt: null,
	...o,
});
const component = (o: Record<string, unknown> = {}) => ({
	id: 'component-1',
	carId: 'car-1',
	slot: 'motor',
	slotType: 'standard',
	name: 'Motor',
	manufacturer: null,
	model: null,
	serialNumber: null,
	notes: null,
	installedAt: '2026-01-01T00:00:00.000Z',
	removedAt: null,
	...o,
});
const plan = (o: Record<string, unknown> = {}) => ({
	id: 'plan-1',
	carId: 'car-1',
	componentId: null,
	name: 'Rebuild shocks',
	intervalDays: 7,
	intervalSessions: null,
	intervalUnit: 'days',
	intervalValue: 7,
	baselineAt: '2026-01-01T00:00:00.000Z',
	baselineSessionCount: 0,
	status: 'active',
	pauseReason: null,
	pausedAt: null,
	...o,
});
const record = (o: Record<string, unknown> = {}) => ({
	id: 'record-1',
	carId: 'car-1',
	componentId: null,
	planId: null,
	performedAt: '2026-01-02T00:00:00.000Z',
	description: 'Service',
	notes: null,
	cost: null,
	currency: null,
	baselineAt: '2026-01-02T00:00:00.000Z',
	baselineSessionCount: 0,
	previousBaselineAt: null,
	previousBaselineSessionCount: null,
	deletedAt: null,
	...o,
});
const joined = (...rows: Record<string, unknown>[]) =>
	Object.fromEntries(
		rows
			.flatMap((row) => Object.values(row))
			.map((value, index) => [`v${index}`, value]),
	);
const json = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});
let active: MockD1Controller | undefined;
const fixture = () => {
	const value = createHonoFixture();
	active = value.d1;
	return value;
};
afterEach(() => {
	active?.expectConsumed();
	active = undefined;
});

describe('consumable maintenance routes', () => {
	test.each([
		[car(), { setupId: null, front: null, rear: null }, []],
		[
			car({ currentSetupId: 'setup-1' }),
			{ setupId: null, front: null, rear: null },
			[null],
		],
		[car({ currentSetupId: 'setup-1' }), { setupId: 'setup-1' }, [setup()]],
	] as const)(
		'returns current setup tire prefill',
		async (parent, expected, rows) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: parent });
			for (const value of rows) d1.queue({ kind: 'first', value });
			const response = await request('/api/v1/cars/car-1/consumables/prefill');
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject(expected);
		},
	);

	test.each(['', '?archived=true', '?archived=all'])(
		'lists car consumables %s',
		async (query) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'all', rows: [consumable()] },
			);
			const response = await request(`/api/v1/cars/car-1/consumables${query}`);
			expect(response.status).toBe(200);
		},
	);

	test('returns a car consumables report', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [consumable()] },
		);
		expect(
			(await request('/api/v1/cars/car-1/consumables/report')).status,
		).toBe(200);
	});

	test('creates tire consumables from current setup prefill', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
			{ kind: 'first', value: setup() },
			{ kind: 'first', value: consumable({ prefilledFromSetupId: 'setup-1' }) },
		);
		const response = await request(
			'/api/v1/cars/car-1/consumables',
			json('POST', {
				kind: 'tires',
				performedAt: '2026-01-02T00:00:00.000Z',
				prefillFromCurrentSetup: true,
			}),
		);
		expect(response.status).toBe(201);
	});

	test('creates a custom fluid consumable', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{
				kind: 'first',
				value: consumable({
					kind: 'fluid',
					fluidArea: 'custom',
					customFluidArea: 'Center diff',
					frontDetails: null,
					frontCost: null,
					frontCurrency: null,
					cost: 5,
					currency: 'USD',
				}),
			},
		);
		const response = await request(
			'/api/v1/cars/car-1/consumables',
			json('POST', {
				kind: 'fluid',
				performedAt: '2026-01-02T00:00:00.000Z',
				fluidArea: 'custom',
				customFluidArea: 'Center diff',
				cost: 5,
				currency: 'usd',
			}),
		);
		expect(response.status).toBe(201);
	});

	test('gets an owned consumable', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: consumable() },
			{ kind: 'first', value: car() },
		);
		expect((await request('/api/v1/consumables/consumable-1')).status).toBe(
			200,
		);
	});

	test.each([
		[
			consumable(),
			{
				front: { details: { compound: 'C' }, cost: 12, currency: 'USD' },
				rear: null,
				performedAt: '2026-02-01T00:00:00.000Z',
				notes: 'Changed',
			},
		],
		[
			consumable({
				kind: 'fluid',
				fluidArea: 'front-shocks',
				frontDetails: null,
				frontCost: null,
				frontCurrency: null,
				cost: 5,
				currency: 'USD',
			}),
			{ fluidArea: 'rear-shocks', cost: 6, currency: 'USD' },
		],
	] as const)('updates a mutable consumable', async (existing, body) => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: existing },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'first', value: { ...existing, notes: 'Changed' } },
			{ kind: 'first', value: car() },
		);
		const response = await request(
			'/api/v1/consumables/consumable-1',
			json('PATCH', body),
		);
		expect(response.status).toBe(200);
	});

	test.each([
		[
			'archive',
			consumable(),
			consumable({ archivedAt: '2026-02-01T00:00:00.000Z' }),
		],
		[
			'restore',
			consumable({ archivedAt: '2026-01-01T00:00:00.000Z' }),
			consumable(),
		],
	] as const)(
		'%s transitions consumable history',
		async (action, before, after) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: before },
				{ kind: 'first', value: car() },
				{ kind: 'first', value: car() },
				{ kind: 'first', value: after },
			);
			expect(
				(
					await request(`/api/v1/consumables/consumable-1/${action}`, {
						method: 'POST',
					})
				).status,
			).toBe(200);
		},
	);

	test('lists global compatibility consumables and reports', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'all', rows: [joined(consumable(), car())] });
		expect((await request('/api/v1/consumable-maintenance')).status).toBe(200);
		d1.queue({ kind: 'all', rows: [joined(consumable(), car())] });
		expect((await request('/api/v1/consumables/report')).status).toBe(200);
	});

	test('supports car-scoped compatibility create, list, edit, archive, and restore', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{
				kind: 'first',
				value: consumable({
					kind: 'fluid',
					fluidArea: 'front-shocks',
					frontDetails: null,
					frontCost: null,
					frontCurrency: null,
				}),
			},
		);
		expect(
			(
				await request(
					'/api/v1/cars/car-1/consumable-maintenance',
					json('POST', {
						kind: 'shock-fluid',
						performedAt: '2026-01-02T00:00:00.000Z',
						cost: 5,
					}),
				)
			).status,
		).toBe(201);
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [consumable()] },
		);
		expect(
			(await request('/api/v1/cars/car-1/consumable-maintenance')).status,
		).toBe(200);
		d1.queue(
			{ kind: 'first', value: consumable() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'first', value: consumable() },
			{ kind: 'first', value: car() },
		);
		expect(
			(
				await request(
					'/api/v1/cars/car-1/consumable-maintenance/consumable-1',
					json('PATCH', {
						kind: 'tires',
						performedAt: '2026-01-03T00:00:00.000Z',
						axle: 'front',
						frontDetails: { compound: 'C' },
					}),
				)
			).status,
		).toBe(200);
		for (const [method, suffix, before, after] of [
			[
				'DELETE',
				'',
				consumable(),
				consumable({ archivedAt: '2026-02-01T00:00:00.000Z' }),
			],
			[
				'POST',
				'/restore',
				consumable({ archivedAt: '2026-01-01T00:00:00.000Z' }),
				consumable(),
			],
		] as const) {
			d1.queue(
				{ kind: 'first', value: before },
				{ kind: 'first', value: car() },
				{ kind: 'first', value: car() },
				{ kind: 'first', value: after },
			);
			expect(
				(
					await request(
						`/api/v1/cars/car-1/consumable-maintenance/consumable-1${suffix}`,
						{ method },
					)
				).status,
			).toBe(200);
		}
	});
});

describe('drive and preference routes', () => {
	test('reads the default timezone and updates a valid IANA timezone', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: { timezone: null } });
		expect(
			await (await request('/api/v1/preferences/timezone')).json(),
		).toEqual({ timezone: 'UTC' });
		d1.queue({ kind: 'run' });
		expect(
			(
				await request(
					'/api/v1/preferences/timezone',
					json('PATCH', { timezone: 'America/Los_Angeles' }),
				)
			).status,
		).toBe(200);
		expect(
			(
				await request(
					'/api/v1/preferences/timezone',
					json('PATCH', { timezone: 'bad' }),
				)
			).status,
		).toBe(400);
		expect(
			(
				await request(
					'/api/v1/preferences/timezone',
					json('PATCH', { timezone: 5 }),
				)
			).status,
		).toBe(400);
	});

	test('counts and lists current and historical drive sessions', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [{ id: 'drive-1' }] },
		);
		expect(
			await (await request('/api/v1/cars/car-1/drives/count')).json(),
		).toEqual({ count: 1 });
		for (const query of ['', '?history=true']) {
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'first', value: { timezone: 'America/Los_Angeles' } },
				{ kind: 'all', rows: [drive()] },
			);
			expect((await request(`/api/v1/cars/car-1/drives${query}`)).status).toBe(
				200,
			);
		}
	});

	test('creates, edits, and soft-deletes a drive session', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'first', value: drive() },
			{ kind: 'first', value: { timezone: 'UTC' } },
		);
		expect(
			(
				await request(
					'/api/v1/cars/car-1/drives',
					json('POST', {
						startedAt: '2026-01-01T20:00:00.000Z',
						durationMinutes: 10,
						conditions: 'dry',
						notes: 'run',
					}),
				)
			).status,
		).toBe(201);
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: drive() },
			{ kind: 'run' },
			{ kind: 'first', value: drive({ notes: 'updated' }) },
			{ kind: 'first', value: { timezone: 'UTC' } },
		);
		expect(
			(
				await request(
					'/api/v1/cars/car-1/drives/drive-1',
					json('PATCH', {
						startedAt: '2026-01-02T20:00:00.000Z',
						durationMinutes: null,
						conditions: null,
						notes: 'updated',
					}),
				)
			).status,
		).toBe(200);
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: drive() },
			{ kind: 'run' },
			{ kind: 'first', value: { timezone: 'UTC' } },
		);
		expect(
			(await request('/api/v1/cars/car-1/drives/drive-1', { method: 'DELETE' }))
				.status,
		).toBe(200);
	});
});

describe('maintenance plans and service records', () => {
	test('covers absent prefill data and canonical tire update shapes', async () => {
		{
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
				{ kind: 'first', value: null },
			);
			expect(
				(
					await request(
						'/api/v1/cars/car-1/consumables',
						json('POST', {
							kind: 'tires',
							performedAt: '2026-01-02T00:00:00.000Z',
							prefillFromCurrentSetup: true,
						}),
					)
				).status,
			).toBe(400);
			d1.expectConsumed();
			active = undefined;
		}
		{
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car({ currentSetupId: 'setup-1' }) },
				{ kind: 'first', value: setup({ tires: 'null' }) },
			);
			expect(
				(
					await request(
						'/api/v1/cars/car-1/consumables',
						json('POST', {
							kind: 'tires',
							performedAt: '2026-01-02T00:00:00.000Z',
							prefillFromCurrentSetup: true,
						}),
					)
				).status,
			).toBe(400);
			d1.expectConsumed();
			active = undefined;
		}

		for (const body of [
			{ rear: null },
			{ front: null, rear: { details: 'Rear' } },
			{ front: { details: 'Front without cost' } },
		]) {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: consumable() },
				{ kind: 'first', value: car() },
				{ kind: 'first', value: car() },
				{ kind: 'run' },
				{ kind: 'first', value: consumable() },
				{ kind: 'first', value: car() },
			);
			expect(
				(await request('/api/v1/consumables/consumable-1', json('PATCH', body)))
					.status,
			).toBe(200);
			d1.expectConsumed();
			active = undefined;
		}
	});

	test('translates every legacy consumable shape through Hono', async () => {
		for (const [body, created] of [
			[
				{
					kind: 'tires',
					performedAt: '2026-01-02T00:00:00.000Z',
					axle: 'rear',
					rearDetails: 'Rear',
					rearCost: 6,
				},
				consumable({
					frontDetails: null,
					frontCost: null,
					frontCurrency: null,
					rearDetails: '{"details":"Rear"}',
					rearCost: 6,
				}),
			],
			[
				{
					kind: 'tires',
					performedAt: '2026-01-02T00:00:00.000Z',
					axle: 'both',
					frontDetails: 'Front',
					rearDetails: 'Rear',
					rearCost: 6,
				},
				consumable({ rearDetails: '{"details":"Rear"}', rearCost: 6 }),
			],
			[
				{
					kind: 'differential-fluid',
					performedAt: '2026-01-02T00:00:00.000Z',
				},
				consumable({
					kind: 'fluid',
					fluidArea: 'front-differential',
					frontDetails: null,
					frontCost: null,
					frontCurrency: null,
				}),
			],
		] as const) {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'first', value: created },
			);
			expect(
				(
					await request(
						'/api/v1/cars/car-1/consumable-maintenance',
						json('POST', body),
					)
				).status,
			).toBe(201);
			d1.expectConsumed();
			active = undefined;
		}

		for (const body of [
			{
				kind: 'tires',
				performedAt: '2026-01-02T00:00:00.000Z',
				axle: 'front',
				frontDetails: 'Front',
				frontCost: 5,
			},
			{
				kind: 'tires',
				performedAt: '2026-01-02T00:00:00.000Z',
				axle: 'rear',
				rearDetails: 'Rear without cost',
			},
		]) {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'first', value: consumable() },
			);
			expect(
				(
					await request(
						'/api/v1/cars/car-1/consumable-maintenance',
						json('POST', body),
					)
				).status,
			).toBe(201);
			d1.expectConsumed();
			active = undefined;
		}

		{
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: car() });
			expect(
				(
					await request(
						'/api/v1/cars/car-1/consumable-maintenance',
						json('POST', {
							kind: 'tires',
							performedAt: '2026-01-02T00:00:00.000Z',
							axle: 'rear',
						}),
					)
				).status,
			).toBe(400);
			d1.expectConsumed();
			active = undefined;
		}

		for (const existing of [
			consumable({
				kind: 'fluid',
				fluidArea: 'front-shocks',
				frontDetails: null,
			}),
			consumable({
				kind: 'fluid',
				fluidArea: 'front-differential',
				frontDetails: null,
			}),
		]) {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: existing },
				{ kind: 'first', value: car() },
				{ kind: 'first', value: car() },
				{ kind: 'run' },
				{ kind: 'first', value: existing },
				{ kind: 'first', value: car() },
			);
			expect(
				(
					await request(
						'/api/v1/cars/car-1/consumable-maintenance/consumable-1',
						json('PATCH', { notes: 'Updated' }),
					)
				).status,
			).toBe(200);
			d1.expectConsumed();
			active = undefined;
		}

		for (const body of [
			{ axle: 'rear', rearDetails: 'Rear without cost' },
			{ axle: 'rear', rearDetails: 'Rear', rearCost: 6 },
		]) {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: consumable() },
				{ kind: 'first', value: car() },
				{ kind: 'first', value: car() },
				{ kind: 'run' },
				{ kind: 'first', value: consumable() },
				{ kind: 'first', value: car() },
			);
			expect(
				(
					await request(
						'/api/v1/cars/car-1/consumable-maintenance/consumable-1',
						json('PATCH', body),
					)
				).status,
			).toBe(200);
			d1.expectConsumed();
			active = undefined;
		}
	});

	test('persists minimal drive and service records', async () => {
		{
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'run' },
				{ kind: 'first', value: drive() },
				{ kind: 'first', value: { timezone: 'UTC' } },
			);
			expect(
				(
					await request(
						'/api/v1/cars/car-1/drives',
						json('POST', { startedAt: '2026-01-02T00:00:00.000Z' }),
					)
				).status,
			).toBe(201);
			d1.expectConsumed();
			active = undefined;
		}

		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'first', value: record({ description: 'Notes only' }) },
		);
		expect(
			(
				await request(
					'/api/v1/cars/car-1/service-records',
					json('POST', {
						performedAt: '2026-01-02T00:00:00.000Z',
						notes: 'Notes only',
					}),
				)
			).status,
		).toBe(201);
		d1.expectConsumed();
		active = undefined;

		const next = fixture();
		next.d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{ kind: 'first', value: record() },
		);
		expect(
			(
				await next.request(
					'/api/v1/cars/car-1/service-records',
					json('POST', {
						performedAt: '2026-01-02T00:00:00.000Z',
						description: 'Description only',
					}),
				)
			).status,
		).toBe(201);
	});

	test('covers session-only plan defaults and missing count rows', async () => {
		{
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'all', rows: [] },
				{ kind: 'run' },
				{
					kind: 'first',
					value: plan({
						intervalDays: null,
						intervalSessions: 5,
						intervalUnit: 'none',
						intervalValue: 1,
					}),
				},
				{ kind: 'first', value: { timezone: 'UTC' } },
			);
			expect(
				(
					await request(
						'/api/v1/maintenance-plans',
						json('POST', {
							carId: 'car-1',
							name: 'Sessions',
							intervalSessions: 5,
						}),
					)
				).status,
			).toBe(201);
			d1.expectConsumed();
			active = undefined;
		}

		{
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'all', rows: [joined(plan(), car())] },
				{ kind: 'first', value: { timezone: 'UTC' } },
				{ kind: 'all', rows: [] },
				{ kind: 'all', rows: [] },
			);
			expect((await request('/api/v1/maintenance-plans')).status).toBe(200);
			d1.expectConsumed();
			active = undefined;
		}

		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'all', rows: [{ id: 'car-1' }] },
			{ kind: 'all', rows: [plan()] },
			{ kind: 'first', value: { timezone: 'UTC' } },
			{ kind: 'all', rows: [] },
		);
		expect((await request('/api/v1/maintenance-cockpit')).status).toBe(200);
	});

	test.each([
		{ intervalUnit: 'none' },
		{ intervalDays: null },
		{ name: 'Name only' },
	])(
		'updates a plan with fallback combination $intervalUnit$intervalDays$name',
		async (body) => {
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: plan() },
				{ kind: 'first', value: car() },
				{ kind: 'run' },
				{ kind: 'first', value: plan() },
				{ kind: 'first', value: car() },
				{ kind: 'all', rows: [] },
				{ kind: 'first', value: { timezone: 'UTC' } },
			);
			expect(
				(await request('/api/v1/maintenance-plans/plan-1', json('PATCH', body)))
					.status,
			).toBe(200);
		},
	);

	test('completes a plan with all completion defaults', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: plan() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [] },
			{ kind: 'batch' },
			{ kind: 'first', value: plan() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: { timezone: 'UTC' } },
		);
		expect(
			(
				await request(
					'/api/v1/maintenance-plans/plan-1/complete',
					json('POST', {}),
				)
			).status,
		).toBe(201);
	});

	test('edits, deletes, and restores service records without a plan', async () => {
		{
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: record() },
				{ kind: 'first', value: car() },
				{ kind: 'batch' },
				{ kind: 'first', value: record({ notes: 'Updated' }) },
			);
			expect(
				(
					await request(
						'/api/v1/service-records/record-1',
						json('PATCH', { description: 'Updated' }),
					)
				).status,
			).toBe(200);
			d1.expectConsumed();
			active = undefined;
		}

		{
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: record() },
				{ kind: 'first', value: car() },
				{ kind: 'batch' },
			);
			expect(
				(
					await request('/api/v1/service-records/record-1', {
						method: 'DELETE',
					})
				).status,
			).toBe(200);
			d1.expectConsumed();
			active = undefined;
		}

		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: record({ deletedAt: '2026-02-01' }) },
			{ kind: 'first', value: car() },
			{ kind: 'batch' },
			{ kind: 'first', value: record() },
		);
		expect(
			(
				await request('/api/v1/service-records/record-1/restore', {
					method: 'POST',
				})
			).status,
		).toBe(200);
	});

	test('restores linked baselines with missing historical session counts', async () => {
		const linked = record({
			planId: 'plan-1',
			baselineSessionCount: null,
			previousBaselineAt: '2026-01-01T00:00:00.000Z',
			previousBaselineSessionCount: null,
		});
		{
			const { d1, request } = fixture();
			d1.queue(
				{ kind: 'first', value: linked },
				{ kind: 'first', value: car() },
				{ kind: 'first', value: plan({ baselineAt: linked.baselineAt }) },
				{ kind: 'batch' },
				{
					kind: 'first',
					value: plan({ baselineAt: linked.previousBaselineAt }),
				},
			);
			expect(
				(
					await request('/api/v1/service-records/record-1', {
						method: 'DELETE',
					})
				).status,
			).toBe(200);
			d1.expectConsumed();
			active = undefined;
		}

		const { d1, request } = fixture();
		d1.queue(
			{
				kind: 'first',
				value: { ...linked, deletedAt: '2026-02-01T00:00:00.000Z' },
			},
			{ kind: 'first', value: car() },
			{ kind: 'first', value: plan({ baselineAt: linked.previousBaselineAt }) },
			{ kind: 'batch' },
			{ kind: 'first', value: linked },
			{ kind: 'first', value: plan({ baselineAt: linked.baselineAt }) },
		);
		expect(
			(
				await request('/api/v1/service-records/record-1/restore', {
					method: 'POST',
				})
			).status,
		).toBe(200);
	});

	test('creates service records with and without a component', async () => {
		for (const componentId of [undefined, 'component-1']) {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: car() });
			if (componentId) d1.queue({ kind: 'first', value: component() });
			d1.queue(
				{ kind: 'run' },
				{ kind: 'first', value: record({ componentId: componentId ?? null }) },
			);
			const response = await request(
				'/api/v1/cars/car-1/service-records',
				json('POST', {
					componentId,
					performedAt: '2026-01-02T00:00:00.000Z',
					description: 'Service',
					notes: 'notes',
					cost: 10,
					currency: 'usd',
					baselineAt: '2026-01-02T00:00:00.000Z',
				}),
			);
			expect(response.status).toBe(201);
			d1.expectConsumed();
			active = undefined;
		}
	});

	test('lists global and car service records including history', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'all', rows: [joined(record(), car())] });
		expect((await request('/api/v1/service-records')).status).toBe(200);
		for (const query of ['', '?history=true']) {
			d1.queue(
				{ kind: 'first', value: car() },
				{ kind: 'all', rows: [record()] },
			);
			expect(
				(await request(`/api/v1/cars/car-1/service-records${query}`)).status,
			).toBe(200);
		}
	});

	test.each([
		[
			{
				name: 'Calendar plan',
				carId: 'car-1',
				intervalUnit: 'days',
				intervalValue: 7,
				baselineAt: '2026-01-01T00:00:00.000Z',
				baselineSessionCount: 0,
			},
			[],
		],
		[
			{
				name: 'Component plan',
				carId: 'car-1',
				componentId: 'component-1',
				intervalDays: 5,
			},
			[component(), { id: 'drive-1' }],
		],
	] as const)('creates maintenance plans', async (body, extras) => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: car() });
		if ('componentId' in body)
			d1.queue(
				{ kind: 'first', value: extras[0] as Record<string, unknown> },
				{ kind: 'all', rows: [extras[1] as Record<string, unknown>] },
			);
		d1.queue(
			{ kind: 'run' },
			{
				kind: 'first',
				value: plan({
					componentId: 'componentId' in body ? body.componentId : null,
				}),
			},
			{ kind: 'first', value: { timezone: 'UTC' } },
		);
		expect(
			(await request('/api/v1/maintenance-plans', json('POST', body))).status,
		).toBe(201);
	});

	test('lists plans, activity, car plans, and both cockpit shapes', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'all', rows: [joined(plan(), car())] },
			{ kind: 'first', value: { timezone: 'UTC' } },
			{ kind: 'all', rows: [{ carId: 'car-1' }] },
			{ kind: 'all', rows: [joined(record({ planId: 'plan-1' }), car())] },
		);
		expect((await request('/api/v1/maintenance-plans')).status).toBe(200);
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [plan()] },
			{ kind: 'first', value: { timezone: 'UTC' } },
			{ kind: 'all', rows: [{ id: 'drive-1' }] },
		);
		expect((await request('/api/v1/cars/car-1/maintenance-plans')).status).toBe(
			200,
		);
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [plan({ status: 'paused' })] },
			{ kind: 'first', value: { timezone: 'UTC' } },
			{ kind: 'all', rows: [] },
			{ kind: 'all', rows: [record()] },
		);
		expect(
			(await request('/api/v1/cars/car-1/maintenance-cockpit')).status,
		).toBe(200);
		d1.queue(
			{ kind: 'all', rows: [{ id: 'car-1' }] },
			{ kind: 'all', rows: [plan()] },
			{ kind: 'first', value: { timezone: 'UTC' } },
			{ kind: 'all', rows: [{ carId: 'car-1' }] },
		);
		expect((await request('/api/v1/maintenance-cockpit')).status).toBe(200);
	});

	test('updates and transitions a maintenance plan through every state', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: plan() },
			{ kind: 'first', value: car() },
			{ kind: 'run' },
			{
				kind: 'first',
				value: plan({ intervalUnit: 'days', intervalValue: 3 }),
			},
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [] },
			{ kind: 'first', value: { timezone: 'UTC' } },
		);
		expect(
			(
				await request(
					'/api/v1/maintenance-plans/plan-1',
					json('PATCH', {
						name: 'Updated',
						intervalUnit: 'days',
						intervalValue: 3,
						intervalSessions: 3,
					}),
				)
			).status,
		).toBe(200);
		for (const [action, before, after] of [
			['pause', plan(), plan({ status: 'paused' })],
			['resume', plan({ status: 'paused' }), plan()],
			['archive', plan(), plan({ status: 'archived' })],
		] as const) {
			d1.queue(
				{ kind: 'first', value: before },
				{ kind: 'first', value: car() },
				{ kind: 'run' },
				{ kind: 'first', value: after },
				{ kind: 'first', value: car() },
				{ kind: 'all', rows: [] },
				{ kind: 'first', value: { timezone: 'UTC' } },
			);
			expect(
				(
					await request(`/api/v1/maintenance-plans/plan-1/${action}`, {
						method: 'POST',
					})
				).status,
			).toBe(200);
		}
	});

	test('completes an active plan into immutable service history', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: plan() },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: car() },
			{ kind: 'all', rows: [{ id: 'drive-1' }] },
			{ kind: 'batch' },
			{
				kind: 'first',
				value: plan({
					baselineAt: '2026-02-01T00:00:00.000Z',
					baselineSessionCount: 1,
				}),
			},
			{ kind: 'first', value: car() },
			{ kind: 'first', value: { timezone: 'UTC' } },
		);
		const response = await request(
			'/api/v1/maintenance-plans/plan-1/complete',
			json('POST', {
				performedAt: '2026-02-01T00:00:00.000Z',
				description: 'Done',
				notes: 'notes',
				cost: 5,
				currency: 'usd',
			}),
		);
		expect(response.status).toBe(201);
	});

	test('edits, deletes, and restores service records with plan baselines', async () => {
		const { d1, request } = fixture();
		const linked = record({
			planId: 'plan-1',
			previousBaselineAt: '2026-01-01T00:00:00.000Z',
			previousBaselineSessionCount: 0,
		});
		d1.queue(
			{ kind: 'first', value: linked },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: plan({ baselineAt: linked.baselineAt }) },
			{ kind: 'batch' },
			{ kind: 'first', value: record({ description: 'Updated' }) },
		);
		expect(
			(
				await request(
					'/api/v1/service-records/record-1',
					json('PATCH', {
						performedAt: '2026-01-03T00:00:00.000Z',
						description: 'Updated',
						notes: null,
						cost: 10,
						currency: 'usd',
					}),
				)
			).status,
		).toBe(200);
		d1.queue(
			{ kind: 'first', value: linked },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: plan({ baselineAt: linked.baselineAt }) },
			{ kind: 'batch' },
			{ kind: 'first', value: plan({ baselineAt: linked.previousBaselineAt }) },
		);
		expect(
			(await request('/api/v1/service-records/record-1', { method: 'DELETE' }))
				.status,
		).toBe(200);
		const deleted = { ...linked, deletedAt: '2026-02-01T00:00:00.000Z' };
		d1.queue(
			{ kind: 'first', value: deleted },
			{ kind: 'first', value: car() },
			{ kind: 'first', value: plan({ baselineAt: linked.previousBaselineAt }) },
			{ kind: 'batch' },
			{ kind: 'first', value: linked },
			{ kind: 'first', value: plan({ baselineAt: linked.baselineAt }) },
		);
		expect(
			(
				await request('/api/v1/service-records/record-1/restore', {
					method: 'POST',
				})
			).status,
		).toBe(200);
	});
});

describe('maintenance route failures', () => {
	test('validates canonical consumable creation and setup prefill availability', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: car() });
		expect(
			(await request('/api/v1/cars/car-1/consumables', json('POST', {})))
				.status,
		).toBe(400);
		d1.queue({ kind: 'first', value: car() });
		expect(
			(
				await request(
					'/api/v1/cars/car-1/consumables',
					json('POST', {
						kind: 'tires',
						performedAt: '2026-01-01T00:00:00.000Z',
						prefillFromCurrentSetup: true,
					}),
				)
			).status,
		).toBe(400);
	});

	test('validates canonical consumable updates and lifecycle transitions', async () => {
		const cases: Array<{
			path: string;
			init: RequestInit;
			steps: Parameters<MockD1Controller['queue']>;
		}> = [
			{
				path: '/api/v1/consumables/missing',
				init: json('PATCH', { notes: 'x' }),
				steps: [{ kind: 'first', value: null }],
			},
			{
				path: '/api/v1/consumables/consumable-1',
				init: json('PATCH', { notes: 'x' }),
				steps: [
					{ kind: 'first', value: consumable() },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: null },
				],
			},
			{
				path: '/api/v1/consumables/consumable-1',
				init: json('PATCH', {}),
				steps: [
					{ kind: 'first', value: consumable() },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car() },
				],
			},
			{
				path: '/api/v1/consumables/consumable-1',
				init: json('PATCH', { fluidArea: 'front-shocks' }),
				steps: [
					{ kind: 'first', value: consumable() },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car() },
				],
			},
			{
				path: '/api/v1/consumables/consumable-1',
				init: json('PATCH', { front: { details: 'x' } }),
				steps: [
					{
						kind: 'first',
						value: consumable({
							kind: 'fluid',
							fluidArea: 'front-shocks',
							frontDetails: null,
						}),
					},
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car() },
				],
			},
			{
				path: '/api/v1/consumables/consumable-1',
				init: json('PATCH', { front: null }),
				steps: [
					{ kind: 'first', value: consumable() },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car() },
				],
			},
			{
				path: '/api/v1/consumables/consumable-1',
				init: json('PATCH', { fluidArea: 'custom', customFluidArea: null }),
				steps: [
					{
						kind: 'first',
						value: consumable({
							kind: 'fluid',
							fluidArea: 'front-shocks',
							frontDetails: null,
						}),
					},
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car() },
				],
			},
			{
				path: '/api/v1/consumables/consumable-1',
				init: json('PATCH', { customFluidArea: 'wrong' }),
				steps: [
					{
						kind: 'first',
						value: consumable({
							kind: 'fluid',
							fluidArea: 'front-shocks',
							frontDetails: null,
						}),
					},
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car() },
				],
			},
		];
		for (const value of cases) {
			const { d1, request } = fixture();
			d1.queue(...value.steps);
			expect(
				(await request(value.path, value.init)).status,
			).toBeGreaterThanOrEqual(400);
			d1.expectConsumed();
			active = undefined;
		}
	});

	test('covers missing, mismatched, immutable, and archived consumable transitions', async () => {
		for (const [path, steps, status] of [
			[
				'/api/v1/consumables/missing/archive',
				[{ kind: 'first', value: null }],
				404,
			],
			[
				'/api/v1/cars/car-2/consumable-maintenance/consumable-1/restore',
				[
					{ kind: 'first', value: consumable() },
					{ kind: 'first', value: car() },
				],
				404,
			],
			[
				'/api/v1/consumables/consumable-1/archive',
				[
					{ kind: 'first', value: consumable() },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: null },
				],
				404,
			],
			[
				'/api/v1/consumables/consumable-1/archive',
				[
					{ kind: 'first', value: consumable() },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car({ archivedAt: 'x' }) },
				],
				409,
			],
			[
				'/api/v1/consumables/consumable-1/archive',
				[
					{ kind: 'first', value: consumable({ archivedAt: 'x' }) },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car() },
				],
				409,
			],
			[
				'/api/v1/consumables/consumable-1/restore',
				[
					{ kind: 'first', value: consumable() },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car() },
				],
				409,
			],
		] as const) {
			const { d1, request } = fixture();
			d1.queue(...steps);
			expect((await request(path, { method: 'POST' })).status).toBe(status);
			d1.expectConsumed();
			active = undefined;
		}
	});

	test('covers compatibility endpoint malformed and rejected edits', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: car() });
		expect(
			(
				await request('/api/v1/cars/car-1/consumable-maintenance', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{',
				})
			).status,
		).toBe(400);
		for (const [steps, body, status] of [
			[[{ kind: 'first', value: null }], {}, 404],
			[
				[
					{ kind: 'first', value: consumable() },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: null },
				],
				{},
				404,
			],
			[
				[
					{ kind: 'first', value: consumable({ archivedAt: 'x' }) },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car() },
				],
				{},
				409,
			],
			[
				[
					{ kind: 'first', value: consumable() },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car() },
				],
				{ performedAt: 'bad' },
				400,
			],
		] as const) {
			const next = fixture();
			next.d1.queue(...steps);
			expect(
				(
					await next.request(
						'/api/v1/cars/car-1/consumable-maintenance/consumable-1',
						json('PATCH', body),
					)
				).status,
			).toBe(status);
			next.d1.expectConsumed();
			active = undefined;
		}
	});
	test.each([
		['GET', '/api/v1/cars/missing/consumables/prefill', undefined],
		['GET', '/api/v1/cars/missing/consumables', undefined],
		['GET', '/api/v1/cars/missing/consumables/report', undefined],
		['GET', '/api/v1/cars/missing/consumable-maintenance', undefined],
		['GET', '/api/v1/cars/missing/drives/count', undefined],
		['GET', '/api/v1/cars/missing/drives', undefined],
		['GET', '/api/v1/cars/missing/maintenance-plans', undefined],
		['GET', '/api/v1/cars/missing/maintenance-cockpit', undefined],
		['GET', '/api/v1/cars/missing/service-records', undefined],
		[
			'POST',
			'/api/v1/cars/missing/consumables',
			{
				kind: 'tires',
				performedAt: '2026-01-01T00:00:00.000Z',
				front: { details: 'A' },
			},
		],
		[
			'POST',
			'/api/v1/cars/missing/consumable-maintenance',
			{
				kind: 'shock-fluid',
				performedAt: '2026-01-01T00:00:00.000Z',
				notes: 'changed',
			},
		],
		[
			'POST',
			'/api/v1/cars/missing/drives',
			{ startedAt: '2026-01-01T00:00:00.000Z' },
		],
		[
			'POST',
			'/api/v1/cars/missing/service-records',
			{ performedAt: '2026-01-01T00:00:00.000Z', description: 'Service' },
		],
		[
			'POST',
			'/api/v1/maintenance-plans',
			{ carId: 'missing', name: 'Plan', intervalDays: 7 },
		],
	] as const)(
		'returns 404 for an unknown car at %s %s',
		async (method, path, body) => {
			const { d1, request } = fixture();
			d1.queue({ kind: 'first', value: null });
			const response = await request(
				path,
				body === undefined ? { method } : json(method, body),
			);
			expect(response.status).toBe(404);
		},
	);

	test.each([
		[
			'POST',
			'/api/v1/cars/car-1/consumables',
			{
				kind: 'tires',
				performedAt: '2026-01-01T00:00:00.000Z',
				front: { details: 'A' },
			},
		],
		[
			'POST',
			'/api/v1/cars/car-1/consumable-maintenance',
			{
				kind: 'shock-fluid',
				performedAt: '2026-01-01T00:00:00.000Z',
				notes: 'x',
			},
		],
		[
			'POST',
			'/api/v1/cars/car-1/drives',
			{ startedAt: '2026-01-01T00:00:00.000Z' },
		],
		[
			'POST',
			'/api/v1/cars/car-1/service-records',
			{ performedAt: '2026-01-01T00:00:00.000Z', description: 'x' },
		],
		[
			'POST',
			'/api/v1/maintenance-plans',
			{ carId: 'car-1', name: 'Plan', intervalDays: 7 },
		],
	] as const)(
		'rejects writes to an archived car at %s %s',
		async (method, path, body) => {
			const { d1, request } = fixture();
			d1.queue({
				kind: 'first',
				value: car({ archivedAt: '2026-01-01T00:00:00.000Z' }),
			});
			expect((await request(path, json(method, body))).status).toBe(409);
		},
	);

	test.each([
		['PATCH', '/api/v1/cars/car-1/drives/drive-1'],
		['DELETE', '/api/v1/cars/car-1/drives/drive-1'],
	] as const)(
		'rejects drive mutation for an archived car with %s',
		async (method, path) => {
			const { d1, request } = fixture();
			d1.queue({
				kind: 'first',
				value: car({ archivedAt: '2026-01-01T00:00:00.000Z' }),
			});
			const init =
				method === 'PATCH' ? json(method, { notes: 'x' }) : { method };
			expect((await request(path, init)).status).toBe(409);
		},
	);

	test.each([
		['PATCH', '/api/v1/service-records/record-1', { notes: 'x' }],
		['DELETE', '/api/v1/service-records/record-1', undefined],
		['POST', '/api/v1/service-records/record-1/restore', undefined],
	] as const)(
		'rejects service history mutation for an archived car with %s',
		async (method, path, body) => {
			const { d1, request } = fixture();
			d1.queue(
				{
					kind: 'first',
					value: record({
						deletedAt: method === 'POST' ? '2026-01-01T00:00:00.000Z' : null,
					}),
				},
				{
					kind: 'first',
					value: car({ archivedAt: '2026-01-01T00:00:00.000Z' }),
				},
			);
			const init = body === undefined ? { method } : json(method, body);
			expect((await request(path, init)).status).toBe(409);
		},
	);

	test('rejects invalid and missing drive sessions', async () => {
		const { d1, request } = fixture();
		expect(
			(await request('/api/v1/cars/car-1/drives', json('POST', {}))).status,
		).toBe(400);
		d1.queue({ kind: 'first', value: car() }, { kind: 'first', value: null });
		expect(
			(
				await request(
					'/api/v1/cars/car-1/drives/missing',
					json('PATCH', { notes: 'x' }),
				)
			).status,
		).toBe(404);
		d1.queue({ kind: 'first', value: car() }, { kind: 'first', value: null });
		expect(
			(await request('/api/v1/cars/car-1/drives/missing', { method: 'DELETE' }))
				.status,
		).toBe(404);
	});

	test('rejects immutable drive sessions and invalid updates', async () => {
		const { d1, request } = fixture();
		for (const [method, body] of [
			['PATCH', { notes: 'x' }],
			['DELETE', undefined],
		] as const) {
			d1.queue(
				{ kind: 'first', value: car() },
				{
					kind: 'first',
					value: drive({ deletedAt: '2026-01-01T00:00:00.000Z' }),
				},
			);
			const init = body ? json(method, body) : { method };
			expect(
				(await request('/api/v1/cars/car-1/drives/drive-1', init)).status,
			).toBe(409);
		}
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: drive() },
		);
		expect(
			(await request('/api/v1/cars/car-1/drives/drive-1', json('PATCH', {})))
				.status,
		).toBe(400);
	});

	test('rejects invalid plan and service-record bodies', async () => {
		const { request } = fixture();
		expect(
			(await request('/api/v1/maintenance-plans', json('POST', {}))).status,
		).toBe(400);
		expect(
			(await request('/api/v1/cars/car-1/service-records', json('POST', {})))
				.status,
		).toBe(400);
	});

	test('lists an empty global plan collection without querying drive sessions', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'all', rows: [] },
			{ kind: 'first', value: { timezone: 'UTC' } },
			{ kind: 'all', rows: [] },
		);
		expect((await request('/api/v1/maintenance-plans')).status).toBe(200);
	});

	test('rejects service records for missing components and plans for removed components', async () => {
		const { d1, request } = fixture();
		d1.queue({ kind: 'first', value: car() }, { kind: 'first', value: null });
		expect(
			(
				await request(
					'/api/v1/cars/car-1/service-records',
					json('POST', {
						componentId: 'missing',
						performedAt: '2026-01-01T00:00:00.000Z',
						description: 'Service',
					}),
				)
			).status,
		).toBe(404);
		d1.queue(
			{ kind: 'first', value: car() },
			{
				kind: 'first',
				value: component({ removedAt: '2026-01-01T00:00:00.000Z' }),
			},
		);
		expect(
			(
				await request(
					'/api/v1/maintenance-plans',
					json('POST', {
						carId: 'car-1',
						componentId: 'component-1',
						name: 'Plan',
						intervalDays: 7,
					}),
				)
			).status,
		).toBe(409);
	});

	test('covers missing and invalid maintenance plan actions', async () => {
		for (const [path, body, steps, status] of [
			[
				'/api/v1/maintenance-plans/missing',
				{},
				[{ kind: 'first', value: null }],
				404,
			],
			[
				'/api/v1/maintenance-plans/plan-1',
				{},
				[
					{ kind: 'first', value: plan() },
					{ kind: 'first', value: car() },
				],
				400,
			],
			[
				'/api/v1/maintenance-plans/missing/pause',
				undefined,
				[{ kind: 'first', value: null }],
				404,
			],
			[
				'/api/v1/maintenance-plans/plan-1/pause',
				undefined,
				[
					{ kind: 'first', value: plan({ status: 'paused' }) },
					{ kind: 'first', value: car() },
				],
				409,
			],
			[
				'/api/v1/maintenance-plans/missing/complete',
				{},
				[{ kind: 'first', value: null }],
				404,
			],
			[
				'/api/v1/maintenance-plans/plan-1/complete',
				{},
				[
					{ kind: 'first', value: plan() },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: null },
				],
				404,
			],
			[
				'/api/v1/maintenance-plans/plan-1/complete',
				{},
				[
					{ kind: 'first', value: plan({ status: 'paused' }) },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car() },
				],
				409,
			],
			[
				'/api/v1/maintenance-plans/plan-1/complete',
				{ cost: 1 },
				[
					{ kind: 'first', value: plan() },
					{ kind: 'first', value: car() },
					{ kind: 'first', value: car() },
				],
				400,
			],
		] as const) {
			const { d1, request } = fixture();
			d1.queue(...steps);
			const method =
				path.endsWith('/plan-1') || path.endsWith('/missing')
					? 'PATCH'
					: 'POST';
			const init = body === undefined ? { method } : json(method, body);
			expect((await request(path, init)).status).toBe(status);
			d1.expectConsumed();
			active = undefined;
		}
	});

	test('returns a stable 500 response when plan transition persistence fails', async () => {
		const { d1, request } = fixture();
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		d1.queue(
			{ kind: 'first', value: plan() },
			{ kind: 'first', value: car() },
			{ kind: 'error', error: new Error('database unavailable') },
		);
		expect(
			(
				await request('/api/v1/maintenance-plans/plan-1/pause', {
					method: 'POST',
				})
			).status,
		).toBe(500);
	});

	test('covers service record lookup and lifecycle rejection paths', async () => {
		for (const [method, path, body, steps, status] of [
			[
				'PATCH',
				'/api/v1/service-records/missing',
				{ notes: 'x' },
				[{ kind: 'first', value: null }],
				404,
			],
			[
				'PATCH',
				'/api/v1/service-records/record-1',
				{ notes: 'x' },
				[
					{ kind: 'first', value: record({ deletedAt: 'x' }) },
					{ kind: 'first', value: car() },
				],
				409,
			],
			[
				'PATCH',
				'/api/v1/service-records/record-1',
				{},
				[
					{ kind: 'first', value: record() },
					{ kind: 'first', value: car() },
				],
				400,
			],
			[
				'PATCH',
				'/api/v1/service-records/record-1',
				{ cost: null, currency: 'USD' },
				[
					{ kind: 'first', value: record() },
					{ kind: 'first', value: car() },
				],
				400,
			],
			[
				'DELETE',
				'/api/v1/service-records/missing',
				undefined,
				[{ kind: 'first', value: null }],
				404,
			],
			[
				'DELETE',
				'/api/v1/service-records/record-1',
				undefined,
				[
					{ kind: 'first', value: record({ deletedAt: 'x' }) },
					{ kind: 'first', value: car() },
				],
				409,
			],
			[
				'POST',
				'/api/v1/service-records/missing/restore',
				undefined,
				[{ kind: 'first', value: null }],
				404,
			],
			[
				'POST',
				'/api/v1/service-records/record-1/restore',
				undefined,
				[
					{ kind: 'first', value: record() },
					{ kind: 'first', value: car() },
				],
				409,
			],
		] as const) {
			const { d1, request } = fixture();
			d1.queue(...steps);
			const init = body === undefined ? { method } : json(method, body);
			expect((await request(path, init)).status).toBe(status);
			d1.expectConsumed();
			active = undefined;
		}
	});

	test('detects a drive update that loses its edit race', async () => {
		const { d1, request } = fixture();
		d1.queue(
			{ kind: 'first', value: car() },
			{ kind: 'first', value: drive() },
			{ kind: 'run' },
			{ kind: 'first', value: null },
		);
		expect(
			(
				await request(
					'/api/v1/cars/car-1/drives/drive-1',
					json('PATCH', { notes: 'x' }),
				)
			).status,
		).toBe(409);
	});
});
