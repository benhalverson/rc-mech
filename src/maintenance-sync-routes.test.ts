import { describe, expect, test } from 'vitest';
import { createHonoFixture, type D1Step } from './testing/hono-fixture';

const operationId = '10000000-0000-4000-8000-000000000001';
const carId = '20000000-0000-4000-8000-000000000001';
const planId = '30000000-0000-4000-8000-000000000001';
const recordId = '40000000-0000-4000-8000-000000000001';
const componentId = '50000000-0000-4000-8000-000000000001';
const now = '2026-10-09T12:00:00.000Z';
const parent = { id: carId, ownerId: 'owner-1', version: 2, archivedAt: null };
const input = {
	componentId: null,
	name: 'Bearings',
	intervalDays: null,
	intervalSessions: 3,
	intervalUnit: 'none',
	intervalValue: 1,
	baselineAt: now,
	baselineSessionCount: 0,
};
const plan = {
	id: planId,
	carId,
	...input,
	status: 'active',
	pauseReason: null,
	pausedAt: null,
};
const serviceInput = {
	componentId: null,
	performedAt: now,
	description: 'Cleaned bearings',
	notes: null,
	cost: null,
	currency: null,
};
const record = {
	id: recordId,
	carId,
	...serviceInput,
	planId: null,
	baselineAt: now,
	baselineSessionCount: null,
	previousBaselineAt: null,
	previousBaselineSessionCount: null,
	deletedAt: null,
};
const planCommand = {
	type: 'maintenance.change',
	entity: 'plan',
	carId,
	baseVersion: 2,
	action: 'save',
	planId,
	base: null,
	input,
};
const serviceCommand = {
	type: 'maintenance.change',
	entity: 'service',
	carId,
	baseVersion: 2,
	action: 'save',
	recordId,
	base: null,
	planBase: null,
	input: serviceInput,
	baselineSessionCount: 2,
};
const reads = (
	plans: Record<string, unknown>[] = [],
	records: Record<string, unknown>[] = [],
): D1Step[] => [
	{ kind: 'first', value: parent },
	{ kind: 'all', rows: plans },
	{ kind: 'all', rows: records },
];
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
const applied: D1Step = { kind: 'batch', changes: [1, 1, 1, 1] };
describe('Maintenance synchronization', () => {
	test('creates plans and services with stable identities, atomic receipts, and capture-time usage', async () => {
		const created = await run(planCommand, [
			...reads(),
			{ kind: 'first', value: null },
			applied,
		]);
		expect(created.result).toMatchObject({
			outcome: 'applied',
			collection: { plans: [plan] },
		});
		expect(created.d1.queries[0]?.values.slice(3, 6)).toEqual([
			'maintenance.change',
			'maintenance',
			carId,
		]);
		expect(created.d1.batches[0]?.[1]).toContain('exists');
		const service = await run({ ...serviceCommand, planBase: plan }, [
			...reads([plan]),
			{ kind: 'first', value: null },
			applied,
		]);
		expect(service.result).toMatchObject({
			collection: {
				records: [{ id: recordId, planId, baselineSessionCount: 2 }],
				plans: [{ id: planId, baselineSessionCount: 2 }],
			},
		});
		expect(service.d1.batches[0]).toHaveLength(4);
		expect(service.d1.batches[0]?.[0]).toContain(
			'"maintenance_plan"."baseline_at" IS ?',
		);
		expect(
			(
				await run(serviceCommand, [
					...reads(),
					{ kind: 'first', value: null },
					applied,
				])
			).result,
		).toMatchObject({ collection: { records: [record] } });
	});
	test.each(['save', 'pause', 'resume', 'archive', 'restore'])(
		'retains plan intent for %s',
		async (action) => {
			const base = {
				...plan,
				status:
					action === 'resume'
						? 'paused'
						: action === 'restore'
							? 'archived'
							: 'active',
			};
			const result = await run({ ...planCommand, action, base }, [
				...reads([base]),
				applied,
			]);
			expect(result.result).toMatchObject({ outcome: 'applied' });
		},
	);
	test.each(['save', 'archive', 'restore'])(
		'retains service history for %s',
		async (action) => {
			const base = { ...record, deletedAt: action === 'restore' ? now : null };
			const result = await run({ ...serviceCommand, action, base }, [
				...reads([], [base]),
				applied,
			]);
			expect(result.result).toMatchObject({ outcome: 'applied' });
			expect(result.d1.batches[0]?.[0]).toContain(
				'"service_record"."description" IS ?',
			);
		},
	);
	test('keeps plan and service conflicts without overwriting remote history', async () => {
		for (const [command, plans, records] of [
			[{ ...planCommand, base: plan }, [{ ...plan, name: 'Remote' }], []],
			[
				{ ...serviceCommand, base: record },
				[],
				[{ ...record, description: 'Remote' }],
			],
			[
				{ ...serviceCommand, planBase: plan },
				[{ ...plan, name: 'Remote' }],
				[],
			],
		] as const) {
			const steps = [
				...reads([...plans], [...records]),
				...(command.base === null
					? [{ kind: 'first' as const, value: null }]
					: []),
				{ kind: 'run' as const },
			];
			expect((await run(command, steps, 'conflict', 409)).result).toMatchObject(
				{ outcome: 'conflict', remote: { carId } },
			);
		}
	});
	test('preserves a missing linked plan as a conflict', async () => {
		await run(
			{ ...serviceCommand, planBase: plan },
			[...reads(), { kind: 'first', value: null }, { kind: 'run' }],
			'conflict',
			409,
		);
	});

	test('rejects malformed, unavailable, archived and mismatched ownership', async () => {
		for (const command of [
			{ ...planCommand, input: {} },
			{ ...planCommand, extra: true },
		])
			expect(
				(await run(command, [{ kind: 'run' }], 'rejected', 422)).result,
			).toMatchObject({ outcome: 'rejected' });
		for (const value of [null, { ...parent, archivedAt: now }])
			await run(
				planCommand,
				[{ kind: 'first', value }, { kind: 'run' }],
				'rejected',
				value ? 409 : 404,
			);
		await run(
			{ ...planCommand, base: { ...plan, id: recordId } },
			[...reads([plan]), { kind: 'run' }],
			'rejected',
			422,
		);
		await run(
			{ ...serviceCommand, base: { ...record, carId: planId } },
			[...reads([], [record]), { kind: 'run' }],
			'rejected',
			422,
		);
	});
	test('rejects identity collisions, invalid lifecycle, and incompatible component changes', async () => {
		for (const command of [planCommand, serviceCommand])
			await run(
				command,
				[
					...reads(),
					{ kind: 'first', value: { id: 'collision' } },
					{ kind: 'run' },
				],
				'rejected',
				409,
			);
		for (const command of [
			{ ...planCommand, action: 'pause' },
			{ ...serviceCommand, action: 'archive' },
		])
			await run(command, [...reads(), { kind: 'run' }], 'rejected', 422);
		for (const [action, status] of [
			['save', 'archived'],
			['pause', 'paused'],
			['resume', 'active'],
			['restore', 'active'],
			['archive', 'archived'],
		]) {
			const base = { ...plan, status };
			await run(
				{ ...planCommand, action, base },
				[...reads([base]), { kind: 'run' }],
				'rejected',
				409,
			);
		}
		const deleted = { ...record, deletedAt: now };
		await run(
			{ ...serviceCommand, base: deleted },
			[...reads([], [deleted]), { kind: 'run' }],
			'rejected',
			409,
		);
		await run(
			{ ...serviceCommand, base: record, action: 'restore' },
			[...reads([], [record]), { kind: 'run' }],
			'rejected',
			409,
		);
		await run(
			{ ...serviceCommand, input: { ...serviceInput, cost: 4 } },
			[...reads(), { kind: 'first', value: null }, { kind: 'run' }],
			'rejected',
			422,
		);
		await run(
			{ ...serviceCommand, planBase: { ...plan, carId: recordId } },
			[...reads([plan]), { kind: 'first', value: null }, { kind: 'run' }],
			'rejected',
			422,
		);
		await run(
			{ ...serviceCommand, base: record, planBase: plan },
			[...reads([plan], [record]), { kind: 'run' }],
			'rejected',
			422,
		);
		const paused = { ...plan, status: 'paused' };
		await run(
			{ ...serviceCommand, planBase: paused },
			[...reads([paused]), { kind: 'first', value: null }, { kind: 'run' }],
			'rejected',
			409,
		);
		await run(
			{ ...planCommand, base: plan, input: { ...input, componentId } },
			[...reads([plan]), { kind: 'run' }],
			'rejected',
			422,
		);
		await run(
			{
				...serviceCommand,
				planBase: plan,
				input: { ...serviceInput, componentId },
			},
			[...reads([plan]), { kind: 'first', value: null }, { kind: 'run' }],
			'rejected',
			422,
		);
	});
	test('validates component ownership without blocking independent service history', async () => {
		for (const value of [null, { id: componentId, carId, removedAt: now }])
			await run(
				{ ...planCommand, input: { ...input, componentId } },
				[
					...reads(),
					{ kind: 'first', value: null },
					{ kind: 'first', value },
					{ kind: 'run' },
				],
				'rejected',
				409,
			);
		for (const command of [
			{ ...planCommand, input: { ...input, componentId } },
			{ ...serviceCommand, input: { ...serviceInput, componentId } },
		])
			await run(command, [
				...reads(),
				{ kind: 'first', value: null },
				{ kind: 'first', value: { id: componentId, carId, removedAt: null } },
				applied,
			]);
	});
	test('preserves concurrent edits when either the Car or record witness loses its race', async () => {
		for (const latest of [null, { ...parent, version: 3 }])
			await run(
				planCommand,
				[
					...reads(),
					{ kind: 'first', value: null },
					{ kind: 'batch', changes: [0, 0, 0] },
					{ kind: 'first', value: latest },
					...(latest
						? [
								{ kind: 'all' as const, rows: [plan] },
								{ kind: 'all' as const, rows: [] },
							]
						: []),
					{ kind: 'run' },
				],
				latest ? 'conflict' : 'rejected',
				latest ? 409 : 404,
			);
	});
	test('prepares complete owner-scoped metadata, including empty Cars', async () => {
		const fixture = createHonoFixture();
		fixture.d1.queue(
			{
				kind: 'all',
				rows: [
					{ id: carId, version: 2 },
					{ id: recordId, version: 0 },
				],
			},
			{ kind: 'all', rows: [plan] },
			{ kind: 'all', rows: [record] },
			{
				kind: 'all',
				rows: [
					{
						id: componentId,
						carId,
						slot: 'motor',
						name: 'Motor',
						removedAt: null,
					},
				],
			},
			{ kind: 'first', value: { timezone: 'UTC' } },
		);
		const response = await fixture.request('/api/v1/maintenance/sync/snapshot');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			collections: [
				{ carId, plans: [plan], records: [record] },
				{ carId: recordId, plans: [], records: [] },
			],
			components: [{ id: componentId }],
			timezone: 'UTC',
		});
		fixture.d1.expectConsumed();
	});
});
