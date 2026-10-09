import { describe, expect, test } from 'vitest';
import { createHonoFixture, type D1Step } from './testing/hono-fixture';

const carId = '10000000-0000-4000-8000-000000000001';
const componentId = '20000000-0000-4000-8000-000000000001';
const operationId = '30000000-0000-4000-8000-000000000001';
const parent = {
	id: carId,
	ownerId: 'owner-1',
	name: 'Buggy',
	version: 2,
	archivedAt: null,
};
const current = {
	id: componentId,
	carId,
	slot: 'motor',
	slotType: 'standard',
	name: 'Stock',
	manufacturer: null,
	model: null,
	serialNumber: null,
	notes: null,
	installedAt: '2026-01-01T00:00:00Z',
	removedAt: null,
};
const command = {
	type: 'build.change',
	action: 'install',
	carId,
	componentId,
	baseVersion: 0,
	base: null,
	input: { slot: 'motor', slotType: 'standard', name: 'New motor' },
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
		kind: 'build.change',
		entityType: 'build',
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

describe('Component synchronization', () => {
	test('claims the Car version, inserts a stable identity, and records a receipt atomically', async () => {
		const result = {
			operationId,
			outcome: 'applied',
			collection: {
				carId,
				version: 3,
				components: [{ id: componentId, name: 'New motor' }],
			},
		};
		const d1 = await run(
			command,
			[
				{ kind: 'first', value: parent },
				{ kind: 'all', rows: [] },
				{ kind: 'first', value: null },
				{ kind: 'batch', changes: [1, 1, 1] },
			],
			result,
		);
		expect(d1.batches[0]).toHaveLength(3);
		expect(d1.batches[0]?.[0]).toContain('"version" = ?');
		expect(d1.batches[0]?.[1]).toContain('exists');
		expect(d1.batches[0]?.[2]).toContain('"request_hash"');
		expect(
			d1.batchQueries
				.flat()
				.find((query) => query.query.startsWith('insert into "component"'))
				?.values,
		).toContain(componentId);
	});

	test.each(['edit', 'remove', 'replace'] as const)(
		'applies %s while preserving maintenance boundaries',
		async (action) => {
			const input = {
				...command.input,
				manufacturer: 'Maker',
				model: 'M',
				serialNumber: 'S',
				notes: 'N',
				installedAt: current.installedAt,
			};
			const change = {
				...command,
				action,
				componentId:
					action === 'replace'
						? '20000000-0000-4000-8000-000000000002'
						: componentId,
				base: current,
				input,
			};
			const steps: D1Step[] = [
				{ kind: 'first', value: parent },
				{ kind: 'all', rows: [current] },
			];
			if (action === 'replace')
				steps.push(
					{ kind: 'first', value: null },
					{ kind: 'first', value: { count: 4 } },
				);
			steps.push({ kind: 'batch', changes: [1, 1, 1, 1, 1] });
			const d1 = await run(change, steps, { operationId, outcome: 'applied' });
			expect(d1.batches[0]?.join(' ')).toContain(
				action === 'edit' ? '"component"' : '"maintenance_plan"',
			);
		},
	);

	test.each([
		[
			'invalid input',
			{ ...command, input: { ...command.input, name: '' } },
			[],
			422,
		],
		['missing Car', command, [{ kind: 'first', value: null }], 404],
		[
			'archived Car',
			command,
			[{ kind: 'first', value: { ...parent, archivedAt: '2026-01-01' } }],
			409,
		],
		[
			'wrong slot type',
			{ ...command, input: { ...command.input, slotType: 'custom' } },
			[{ kind: 'first', value: parent }],
			422,
		],
		[
			'foreign base',
			{
				...command,
				base: { ...current, carId: '10000000-0000-4000-8000-000000000009' },
			},
			[{ kind: 'first', value: parent }],
			422,
		],
		[
			'changed slot',
			{ ...command, base: { ...current, slot: 'esc' } },
			[{ kind: 'first', value: parent }],
			422,
		],
		[
			'missing edit base',
			{ ...command, action: 'edit' },
			[{ kind: 'first', value: parent }],
			422,
		],
		[
			'wrong edit identity',
			{
				...command,
				action: 'edit',
				base: current,
				componentId: '20000000-0000-4000-8000-000000000009',
			},
			[{ kind: 'first', value: parent }],
			422,
		],
		[
			'identity collision',
			command,
			[
				{ kind: 'first', value: parent },
				{ kind: 'all', rows: [] },
				{ kind: 'first', value: { id: componentId } },
			],
			409,
		],
	] as const)(
		'retains a terminal receipt for %s',
		async (_label, change, preceding, status) => {
			await run(
				change,
				[...preceding, { kind: 'run' }],
				{ operationId, outcome: 'rejected' },
				status,
			);
		},
	);

	test.each([
		['new remote installation', null, [current]],
		['remote removal', current, []],
		['remote edit', current, [{ ...current, name: 'Remote' }]],
	] as const)(
		'retains both versions for a %s',
		async (_label, base, components) => {
			await run(
				{ ...command, base },
				[
					{ kind: 'first', value: parent },
					{ kind: 'all', rows: components },
					{ kind: 'run' },
				],
				{ operationId, outcome: 'conflict' },
				409,
			);
		},
	);

	test.each([true, false])(
		'fences an affected-row race (Car retained: %s)',
		async (retained) => {
			const steps: D1Step[] = [
				{ kind: 'first', value: parent },
				{ kind: 'all', rows: [] },
				{ kind: 'first', value: null },
				{ kind: 'batch', changes: [0, 0, 0] },
				{ kind: 'first', value: retained ? { ...parent, version: 4 } : null },
			];
			if (retained) steps.push({ kind: 'all', rows: [current] });
			steps.push({ kind: 'run' });
			await run(
				command,
				steps,
				{ operationId, outcome: retained ? 'conflict' : 'rejected' },
				retained ? 409 : 404,
			);
		},
	);
	test('prepares only the authenticated owner builds, including empty builds', async () => {
		const fixture = createHonoFixture();
		fixture.d1.queue({
			kind: 'all',
			rows: [
				{ ownerCarId: carId, version: 2, ...current },
				{
					ownerCarId: carId,
					version: 2,
					...current,
					id: 'other-part',
					slot: 'esc',
				},
				{
					ownerCarId: 'empty-car',
					version: 1,
					id: null,
					carId: null,
					slot: null,
					slotType: null,
					name: null,
					manufacturer: null,
					model: null,
					serialNumber: null,
					notes: null,
					installedAt: null,
					removedAt: null,
				},
			],
		});
		const response = await fixture.request('/api/v1/components');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			collections: [
				{
					carId,
					version: 2,
					components: [current, { ...current, id: 'other-part', slot: 'esc' }],
				},
				{ carId: 'empty-car', version: 1, components: [] },
			],
		});
		expect(fixture.d1.queries[0]?.query).toContain('"car"."owner_id" = ?');
		expect(fixture.d1.queries[0]?.values).toContain('owner-1');
		fixture.d1.expectConsumed();
	});
	test('retains unrelated slots and preserves an edited installation timestamp', async () => {
		await run(
			command,
			[
				{ kind: 'first', value: parent },
				{ kind: 'all', rows: [{ ...current, id: 'other', slot: 'esc' }] },
				{ kind: 'first', value: null },
				{ kind: 'batch' },
			],
			{
				collection: {
					components: [
						{ id: 'other', slot: 'esc' },
						{ id: componentId, name: 'New motor' },
					],
				},
			},
		);
		await run(
			{ ...command, action: 'edit', base: current },
			[
				{ kind: 'first', value: parent },
				{ kind: 'all', rows: [current] },
				{ kind: 'batch' },
			],
			{
				collection: {
					components: [{ id: componentId, installedAt: current.installedAt }],
				},
			},
		);
	});
	test('replays an acknowledged Build receipt without a second Component mutation', async () => {
		const fixture = createHonoFixture();
		const acknowledged = {
			operationId,
			outcome: 'applied',
			collection: { carId, version: 3, components: [current] },
		};
		const receipt = {
			ownerId: 'owner-1',
			operationId,
			contractVersion: 1,
			kind: 'build.change',
			entityType: 'build',
			entityId: carId,
			get requestHash() {
				return fixture.d1.queries[0]?.values[6];
			},
			outcome: 'applied',
			httpStatus: 200,
			responseJson: JSON.stringify(acknowledged),
		};
		fixture.d1.queue(
			{ kind: 'first', value: null },
			{ kind: 'first', value: receipt },
			{ kind: 'first', value: null },
			{ kind: 'first', value: receipt },
		);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await fixture.request(
				`/api/v1/sync/operations/${operationId}`,
				{
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ contractVersion: 1, command }),
				},
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(acknowledged);
		}
		expect(fixture.d1.batches).toEqual([]);
		expect(
			fixture.d1.queries.every((query) =>
				query.query.includes('sync_operation'),
			),
		).toBe(true);
		fixture.d1.expectConsumed();
	});
});
