import { describe, expect, test } from 'vitest';
import { createHonoFixture, type D1Step } from './testing/hono-fixture';

const operationId = '10000000-0000-4000-8000-000000000001';
const carId = '20000000-0000-4000-8000-000000000001';
const entryId = '30000000-0000-4000-8000-000000000001';
const now = '2026-10-09T12:00:00.000Z';
const parent = { id: carId, ownerId: 'owner-1', version: 2, archivedAt: null };
const input = {
	kind: 'tires',
	performedAt: now,
	fluidArea: null,
	customFluidArea: null,
	frontDetails: '{"details":"Front pin tires"}',
	frontCost: 12,
	frontCurrency: 'USD',
	rearDetails: null,
	rearCost: null,
	rearCurrency: null,
	cost: null,
	currency: null,
	notes: null,
};
const entry = {
	id: entryId,
	carId,
	...input,
	prefilledFromSetupId: null,
	archivedAt: null,
	createdAt: now,
	updatedAt: now,
};
const command = {
	type: 'maintenance.change',
	entity: 'consumable',
	carId,
	baseVersion: 2,
	entryId,
	action: 'save',
	base: null,
	input,
};
const reads = (entries: Record<string, unknown>[] = []): D1Step[] => [
	{ kind: 'first', value: parent },
	{ kind: 'all', rows: [] },
	{ kind: 'all', rows: [] },
	{ kind: 'all', rows: entries },
];
const applied: D1Step = { kind: 'batch', changes: [1, 1, 1] };
const run = async (
	command: object,
	steps: D1Step[],
	outcome = 'applied',
	status = 200,
) => {
	const fixture = createHonoFixture();
	const receipt = {
		ownerId: 'owner-1',
		operationId,
		contractVersion: 1,
		kind: 'maintenance.change',
		entityType: 'maintenance',
		entityId: carId,
		get requestHash() {
			return fixture.d1.queries[0]?.values[6];
		},
		outcome: 'pending',
		createdAt: now,
	};
	fixture.d1.queue({ kind: 'first', value: receipt }, ...steps, {
		kind: 'first',
		value: {
			...receipt,
			get requestHash() {
				return receipt.requestHash;
			},
			outcome,
			httpStatus: status,
			get responseJson() {
				return [...fixture.d1.batchQueries.flat(), ...fixture.d1.queries]
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
			body: JSON.stringify({ contractVersion: 1, command }),
		},
	);
	expect(response.status).toBe(status);
	const result = await response.json();
	fixture.d1.expectConsumed();
	return { ...fixture, result };
};

describe('Consumable synchronization', () => {
	test('creates stable tire and fluid entries with one atomic receipt', async () => {
		const result = await run(command, [
			...reads(),
			{ kind: 'first', value: null },
			applied,
		]);
		expect(result.result).toMatchObject({
			outcome: 'applied',
			collection: { consumables: [{ id: entryId, frontCost: 12 }] },
		});
		expect(result.d1.batches[0]).toHaveLength(3);
		expect(result.d1.batches[0]?.[1]).toContain('exists');
		for (const fluid of [
			{
				cost: 8,
				currency: 'USD',
				notes: 'Oil change',
				customFluidArea: 'center diff',
				fluidArea: 'custom',
			},
			{
				cost: null,
				currency: null,
				notes: null,
				customFluidArea: null,
				fluidArea: 'front-shocks',
			},
		]) {
			await run(
				{
					...command,
					input: {
						...input,
						kind: 'fluid',
						frontDetails: null,
						frontCost: null,
						frontCurrency: null,
						...fluid,
					},
				},
				[...reads(), { kind: 'first', value: null }, applied],
			);
		}
	});
	test.each(['save', 'archive', 'restore'])(
		'compares the full mutable base before %s',
		async (action) => {
			const base = { ...entry, archivedAt: action === 'restore' ? now : null };
			const result = await run({ ...command, base, action }, [
				...reads([base]),
				applied,
			]);
			expect(result.d1.batches[0]?.[0]).toContain(
				'"consumable_maintenance_entry"."front_cost" IS ?',
			);
			expect(result.result).toMatchObject({
				collection: {
					consumables: [
						{
							id: entryId,
							archivedAt: action === 'archive' ? expect.any(String) : null,
						},
					],
				},
			});
		},
	);
	test('retains both versions and canonical rejection feedback', async () => {
		await run(
			{ ...command, base: entry },
			[...reads([{ ...entry, frontCost: 20 }]), { kind: 'run' }],
			'conflict',
			409,
		);
		for (const base of [
			{ ...entry, id: operationId },
			{ ...entry, carId: operationId },
		])
			await run(
				{ ...command, base },
				[...reads([entry]), { kind: 'run' }],
				'rejected',
				422,
			);
		await run(
			{ ...command, action: 'archive' },
			[...reads(), { kind: 'run' }],
			'rejected',
			422,
		);
		await run(
			command,
			[...reads(), { kind: 'first', value: { id: entryId } }, { kind: 'run' }],
			'rejected',
			409,
		);
		await run(
			{ ...command, base: entry, input: { ...input, kind: 'fluid' } },
			[...reads([entry]), { kind: 'run' }],
			'rejected',
			422,
		);
		for (const action of ['save', 'archive', 'restore']) {
			const base = { ...entry, archivedAt: action === 'restore' ? null : now };
			await run(
				{ ...command, base, action },
				[...reads([base]), { kind: 'run' }],
				'rejected',
				409,
			);
		}
	});
	test('validates owner, active Car, and canonical input without provider calls', async () => {
		await run(
			command,
			[{ kind: 'first', value: null }, { kind: 'run' }],
			'rejected',
			404,
		);
		await run(
			command,
			[
				{ kind: 'first', value: { ...parent, archivedAt: now } },
				{ kind: 'run' },
			],
			'rejected',
			409,
		);
		for (const changes of [
			{ frontDetails: 'not JSON' },
			{ frontDetails: null },
			{ frontCurrency: null },
			{ kind: 'fluid', fluidArea: 'custom' },
		])
			await run(
				{ ...command, input: { ...input, ...changes } },
				[...reads(), { kind: 'first', value: null }, { kind: 'run' }],
				'rejected',
				422,
			);
	});
	test('preserves concurrent legacy edits or Car archival when the witness loses', async () => {
		for (const latest of [
			null,
			{ ...parent, archivedAt: now },
			{ ...parent, version: 3 },
		]) {
			await run(
				command,
				[
					...reads(),
					{ kind: 'first', value: null },
					{ kind: 'batch', changes: [0, 0, 0] },
					{ kind: 'first', value: latest },
					...(latest && !latest.archivedAt
						? [
								{ kind: 'all' as const, rows: [] },
								{ kind: 'all' as const, rows: [] },
								{ kind: 'all' as const, rows: [entry] },
							]
						: []),
					{ kind: 'run' },
				],
				latest && !latest.archivedAt ? 'conflict' : 'rejected',
				409,
			);
		}
	});
	test('prepares all owner-scoped Consumable metadata and accepts missing optional cost', async () => {
		const fixture = createHonoFixture();
		fixture.d1.queue(
			{
				kind: 'all',
				rows: [
					{ id: carId, version: 2 },
					{ id: operationId, version: 0 },
				],
			},
			{ kind: 'all', rows: [] },
			{ kind: 'all', rows: [] },
			{ kind: 'all', rows: [entry] },
			{ kind: 'all', rows: [] },
			{ kind: 'first', value: { timezone: 'UTC' } },
		);
		const response = await fixture.request('/api/v1/maintenance/sync/snapshot');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			collections: [
				{ carId, consumables: [entry] },
				{ carId: operationId, consumables: [] },
			],
		});
		expect(fixture.d1.queries[3]?.query).toContain('"car"."owner_id"');
		fixture.d1.expectConsumed();
		await run(
			{ ...command, input: { ...input, frontCost: null, frontCurrency: null } },
			[...reads(), { kind: 'first', value: null }, applied],
		);
	});
});
