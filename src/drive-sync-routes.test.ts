import { describe, expect, test } from 'vitest';
import { createHonoFixture, type D1Step } from './testing/hono-fixture';

const carId = '10000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000001';
const operationId = '30000000-0000-4000-8000-000000000001';
const parent = {
	id: carId,
	ownerId: 'owner-1',
	name: 'Buggy',
	version: 2,
	archivedAt: null,
};
const current = {
	id: sessionId,
	carId,
	startedAt: '2026-01-01T00:00:00Z',
	durationMinutes: 10,
	conditions: 'Dry',
	notes: 'Grip',
	deletedAt: null,
};
const input = {
	startedAt: current.startedAt,
	durationMinutes: 20,
	conditions: 'Wet',
	notes: 'Slippery',
};
const command = {
	type: 'drive.change',
	action: 'save',
	carId,
	sessionId,
	baseVersion: 0,
	base: null,
	input,
};

const run = async (
	change: object,
	steps: readonly D1Step[],
	expected: object,
	status = 200,
) => {
	const fixture = createHonoFixture();
	const receipt = {
		ownerId: 'owner-1',
		operationId,
		contractVersion: 1,
		kind: 'drive.change',
		entityType: 'drive',
		entityId: carId,
		get requestHash() {
			return fixture.d1.queries[0]?.values[6];
		},
		outcome: 'pending',
		createdAt: '2026-01-01T00:00:00Z',
	};
	fixture.d1.queue({ kind: 'first', value: receipt }, ...steps, {
		kind: 'first',
		value: {
			...receipt,
			outcome:
				status === 200 ? 'applied' : status === 409 ? 'conflict' : 'rejected',
			httpStatus: status,
			get responseJson() {
				return [
					...(status === 200
						? fixture.d1.batchQueries.flat()
						: fixture.d1.queries),
				]
					.reverse()
					.flatMap((query) => query.values)
					.find(
						(value) =>
							typeof value === 'string' && value.startsWith('{"operationId"'),
					);
			},
		},
	});
	const response = await fixture.request(
		`/api/v1/sync/operations/${operationId}`,
		{
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ contractVersion: 1, command: change }),
		},
	);
	expect(response.status).toBe(status);
	expect(await response.json()).toMatchObject(expected);
	fixture.d1.expectConsumed();
	return fixture.d1;
};

describe('Drive session synchronization', () => {
	test('creates stable identities and receipts in the same conditional batch', async () => {
		const d1 = await run(
			command,
			[
				{ kind: 'first', value: parent },
				{ kind: 'all', rows: [] },
				{ kind: 'first', value: null },
				{ kind: 'batch', changes: [1, 1, 1] },
			],
			{
				outcome: 'applied',
				collection: {
					carId,
					version: 3,
					sessions: [{ id: sessionId, ...input, deletedAt: null }],
				},
			},
		);
		expect(d1.queries[0]?.values.slice(3, 6)).toEqual([
			'drive.change',
			'drive',
			carId,
		]);
		expect(d1.batches[0]).toHaveLength(3);
		expect(d1.batches[0]?.[1]).toContain('exists');
		expect(d1.batches[0]?.[2]).toContain('request_hash');
	});
	test.each(['save', 'archive'])('preserves history for %s', async (action) => {
		await run(
			{ ...command, action, base: current },
			[
				{ kind: 'first', value: parent },
				{ kind: 'all', rows: [current, { ...current, id: 'other' }] },
				{ kind: 'batch', changes: [1, 1, 1] },
			],
			{
				outcome: 'applied',
				collection: {
					sessions: [
						{
							id: sessionId,
							deletedAt: action === 'archive' ? expect.any(String) : null,
						},
						{ id: 'other' },
					],
				},
			},
		);
	});
	test('retains incompatible remote changes', async () => {
		await run(
			{ ...command, base: current },
			[
				{ kind: 'first', value: parent },
				{ kind: 'all', rows: [{ ...current, notes: 'Remote' }] },
				{ kind: 'run' },
			],
			{ outcome: 'conflict', remote: { sessions: [{ notes: 'Remote' }] } },
			409,
		);
	});
	test('retains a remotely missing edited record', async () => {
		await run(
			{ ...command, base: current },
			[
				{ kind: 'first', value: parent },
				{ kind: 'all', rows: [] },
				{ kind: 'run' },
			],
			{ outcome: 'conflict' },
			409,
		);
	});
	test('refuses an occupied identity without disclosing another owner', async () => {
		await run(
			command,
			[
				{ kind: 'first', value: parent },
				{ kind: 'all', rows: [] },
				{ kind: 'first', value: { id: sessionId } },
				{ kind: 'run' },
			],
			{ outcome: 'rejected', error: { code: 'DRIVE_ID_UNAVAILABLE' } },
			409,
		);
	});
	test.each([
		{ ...command, input: { ...input, durationMinutes: -1 } },
		{
			...command,
			base: { ...current, carId: '10000000-0000-4000-8000-000000000002' },
		},
		{
			...command,
			base: { ...current, id: '20000000-0000-4000-8000-000000000002' },
		},
		{ ...command, base: { ...current, deletedAt: '2026-01-01' } },
		{ ...command, action: 'archive' },
	])('retains invalid intent: %j', async (change) => {
		const invalidInput = change.input.durationMinutes === -1;
		await run(
			change,
			[
				...(invalidInput ? [] : [{ kind: 'first' as const, value: parent }]),
				{ kind: 'run' },
			],
			{ outcome: 'rejected', error: { code: 'DRIVE_VALIDATION_FAILED' } },
			422,
		);
	});
	test.each([null, { ...parent, archivedAt: '2026-01-01' }])(
		'rejects unavailable Car: %j',
		async (value) => {
			await run(
				command,
				[{ kind: 'first', value }, { kind: 'run' }],
				{ outcome: 'rejected' },
				value ? 409 : 404,
			);
		},
	);
	test.each([null, { ...parent, version: 4 }])(
		'does not overwrite a racing Car change: %j',
		async (latest) => {
			await run(
				command,
				[
					{ kind: 'first', value: parent },
					{ kind: 'all', rows: [] },
					{ kind: 'first', value: null },
					{ kind: 'batch', changes: [0, 0, 0] },
					{ kind: 'first', value: latest },
					...(latest ? [{ kind: 'all' as const, rows: [current] }] : []),
					{ kind: 'run' },
				],
				{ outcome: latest ? 'conflict' : 'rejected' },
				latest ? 409 : 404,
			);
		},
	);
	test('exports only owned Drive histories including empty Cars', async () => {
		const f = createHonoFixture();
		f.d1.queue(
			{ kind: 'first', value: { timezone: 'America/New_York' } },
			{
				kind: 'all',
				rows: [
					{ ownerCarId: carId, version: 1, ...current },
					{
						ownerCarId: 'empty',
						version: 2,
						id: null,
						carId: null,
						startedAt: null,
						durationMinutes: null,
						conditions: null,
						notes: null,
						deletedAt: null,
					},
				],
			},
		);
		const r = await f.request('/api/v1/drives');
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({
			collections: [
				{
					carId,
					version: 1,
					timezone: 'America/New_York',
					sessions: [current],
				},
				{
					carId: 'empty',
					version: 2,
					timezone: 'America/New_York',
					sessions: [],
				},
			],
		});
		expect(f.d1.queries[0]?.values).toContain('owner-1');
		f.d1.expectConsumed();
	});
});
