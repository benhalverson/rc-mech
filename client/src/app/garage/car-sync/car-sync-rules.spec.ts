import { describe, expect, it } from 'vitest';
import type { GarageCar } from '../garage.models';
import type { CarSyncOperation } from './car-sync.models';
import {
	buildCarSyncOperation,
	carSyncMark,
	materializeCars,
	readyCarSyncOperations,
	rebaseCarSyncOperation,
} from './car-sync-rules';

const car = (overrides: Partial<GarageCar> = {}): GarageCar => ({
	id: 'car-1',
	name: 'B7 carpet',
	make: 'Associated',
	model: 'B7',
	archivedAt: null,
	createdAt: '2026-08-11T10:00:00.000Z',
	version: 3,
	...overrides,
});

const operation = (
	overrides: Partial<CarSyncOperation> = {},
): CarSyncOperation => ({
	operationId: 'operation-1',
	ownerKey: 'owner-1',
	carId: 'car-1',
	command: {
		type: 'car.edit',
		carId: 'car-1',
		baseVersion: 3,
		base: { name: 'B7 carpet' },
		changes: { name: 'B7 club' },
	},
	dependencies: [],
	status: 'pending',
	createdAt: '2026-08-11T10:01:00.000Z',
	...overrides,
});

describe('Car sync rules', () => {
	it('builds a stable create operation with a client-owned Car identity', () => {
		const result = buildCarSyncOperation(
			{ type: 'create', input: { name: 'New buggy', make: 'Schumacher' } },
			[],
			[],
			{
				ownerKey: 'owner-1',
				operationId: 'operation-create',
				carId: 'car-created',
				createdAt: '2026-08-11T11:00:00.000Z',
			},
		);

		expect(result.operation).toMatchObject({
			operationId: 'operation-create',
			carId: 'car-created',
			dependencies: [],
			command: {
				type: 'car.create',
				carId: 'car-created',
				car: { name: 'New buggy', make: 'Schumacher' },
			},
		});
		expect(result.car).toMatchObject({
			id: 'car-created',
			name: 'New buggy',
			version: 0,
			archivedAt: null,
		});
	});

	it('captures only edited base fields and chains work for the same Car', () => {
		const prior = operation({ operationId: 'operation-prior' });
		const result = buildCarSyncOperation(
			{
				type: 'edit',
				carId: 'car-1',
				input: { name: 'B7 club', notes: 'Fresh tires' },
			},
			[car({ notes: null })],
			[prior],
			{
				ownerKey: 'owner-1',
				operationId: 'operation-edit',
				createdAt: '2026-08-11T11:01:00.000Z',
			},
		);

		expect(result.operation.dependencies).toEqual(['operation-prior']);
		expect(result.operation.command).toEqual({
			type: 'car.edit',
			carId: 'car-1',
			baseVersion: 3,
			base: { name: 'B7 carpet', notes: null },
			changes: { name: 'B7 club', notes: 'Fresh tires' },
		});
		expect(result.car).toMatchObject({
			name: 'B7 club',
			notes: 'Fresh tires',
		});
	});

	it('uses a durable sequence when several commands share one timestamp', () => {
		const created = buildCarSyncOperation(
			{ type: 'create', input: { name: 'Same-millisecond Car' } },
			[],
			[],
			{
				ownerKey: 'owner-1',
				operationId: 'z-create',
				carId: 'car-created',
				createdAt: '2026-08-11T11:00:00.000Z',
			},
		);
		const edited = buildCarSyncOperation(
			{ type: 'edit', carId: 'car-created', input: { name: 'Renamed' } },
			[created.car],
			[created.operation],
			{
				ownerKey: 'owner-1',
				operationId: 'a-edit',
				createdAt: '2026-08-11T11:00:00.000Z',
			},
		);
		const archived = buildCarSyncOperation(
			{ type: 'archive', carId: 'car-created' },
			[edited.car],
			[created.operation, edited.operation],
			{
				ownerKey: 'owner-1',
				operationId: '0-archive',
				createdAt: '2026-08-11T11:00:00.000Z',
			},
		);

		expect(created.operation.sequence).toBe(1);
		expect(edited.operation).toMatchObject({
			sequence: 2,
			dependencies: ['z-create'],
		});
		expect(archived.operation).toMatchObject({
			sequence: 3,
			dependencies: ['a-edit'],
		});
		expect(
			materializeCars(
				[],
				[archived.operation, edited.operation, created.operation],
			),
		).toEqual([
			expect.objectContaining({
				id: 'car-created',
				name: 'Renamed',
				archivedAt: '2026-08-11T11:00:00.000Z',
			}),
		]);
	});

	it('rebases dependent edit and lifecycle commands onto acknowledgements', () => {
		const edit = operation({
			operationId: 'edit-dependent',
			dependencies: ['archive-operation'],
			command: {
				type: 'car.edit',
				carId: 'car-1',
				baseVersion: 3,
				base: { name: 'Local name', notes: 'Local notes' },
				changes: { name: 'Next name', notes: 'Next notes' },
			},
		});
		const restore = operation({
			operationId: 'restore-dependent',
			dependencies: ['archive-operation'],
			command: {
				type: 'car.restore',
				carId: 'car-1',
				baseVersion: 3,
				base: { archivedAt: '2026-08-11T11:00:00.000Z' },
			},
		});
		const acknowledged = car({
			name: 'Server name',
			notes: 'Server notes',
			archivedAt: '2026-08-11T11:00:01.000Z',
			version: 4,
		});

		expect(
			rebaseCarSyncOperation(edit, 'archive-operation', acknowledged),
		).toMatchObject({
			dependencies: [],
			command: {
				baseVersion: 4,
				base: { name: 'Server name', notes: 'Server notes' },
			},
		});
		expect(
			rebaseCarSyncOperation(restore, 'archive-operation', acknowledged),
		).toMatchObject({
			dependencies: [],
			command: {
				baseVersion: 4,
				base: { archivedAt: '2026-08-11T11:00:01.000Z' },
			},
		});
		expect(
			rebaseCarSyncOperation(edit, 'unrelated-operation', acknowledged),
		).toBe(edit);
		expect(
			rebaseCarSyncOperation(
				operation({
					dependencies: ['create-operation'],
					command: {
						type: 'car.create',
						carId: 'car-1',
						car: { name: 'Car' },
					},
				}),
				'create-operation',
				acknowledged,
			),
		).toMatchObject({ dependencies: [] });
		expect(
			rebaseCarSyncOperation(
				operation({
					dependencies: ['previous'],
					command: {
						type: 'car.edit',
						carId: 'car-1',
						baseVersion: 1,
						base: { notes: 'Old' },
						changes: { notes: 'Next' },
					},
				}),
				'previous',
				{ id: 'car-1', name: 'Server Car' },
			),
		).toMatchObject({ command: { baseVersion: 0, base: { notes: null } } });
		expect(
			rebaseCarSyncOperation(
				{ ...restore, dependencies: ['previous'] },
				'previous',
				{ id: 'car-1', name: 'Server Car' },
			),
		).toMatchObject({
			command: { baseVersion: 0, base: { archivedAt: null } },
		});
	});

	it('captures lifecycle bases and refuses commands for a missing Car', () => {
		const archived = buildCarSyncOperation(
			{ type: 'archive', carId: 'car-1' },
			[car()],
			[],
			{
				ownerKey: 'owner-1',
				operationId: 'operation-archive',
				createdAt: '2026-08-11T11:02:00.000Z',
			},
		);
		expect(archived.operation.command).toEqual({
			type: 'car.archive',
			carId: 'car-1',
			baseVersion: 3,
			base: { archivedAt: null },
		});
		expect(archived.car.archivedAt).toBe('2026-08-11T11:02:00.000Z');

		expect(() =>
			buildCarSyncOperation({ type: 'restore', carId: 'missing' }, [], [], {
				ownerKey: 'owner-1',
				operationId: 'operation-restore',
				createdAt: '2026-08-11T11:03:00.000Z',
			}),
		).toThrow('Car not found');
		const restored = buildCarSyncOperation(
			{ type: 'restore', carId: 'car-1' },
			[car({ archivedAt: '2026-08-01T00:00:00.000Z', version: undefined })],
			[],
			{
				ownerKey: 'owner-1',
				operationId: 'operation-restore',
				createdAt: '2026-08-11T11:03:00.000Z',
			},
		);
		expect(restored.operation.command).toMatchObject({
			type: 'car.restore',
			baseVersion: 0,
			base: { archivedAt: '2026-08-01T00:00:00.000Z' },
		});
		expect(restored.car.archivedAt).toBeNull();
		const unversionedEdit = buildCarSyncOperation(
			{ type: 'edit', carId: 'car-1', input: { name: 'Legacy renamed' } },
			[car({ version: undefined })],
			[],
			{
				ownerKey: 'owner-1',
				operationId: 'operation-legacy-edit',
				createdAt: '2026-08-11T11:04:00.000Z',
			},
		);
		expect(unversionedEdit.operation.command).toMatchObject({ baseVersion: 0 });
	});

	it('requires a create identity and ignores operations for missing Cars', () => {
		expect(() =>
			buildCarSyncOperation(
				{ type: 'create', input: { name: 'No identity' } },
				[],
				[],
				{
					ownerKey: 'owner-1',
					operationId: 'operation-create',
					createdAt: '2026-08-11T11:00:00.000Z',
				},
			),
		).toThrow('stable Car identity');
		expect(
			materializeCars(
				[],
				[
					operation({
						command: {
							type: 'car.edit',
							carId: 'missing',
							baseVersion: 1,
							base: { name: 'Old' },
							changes: { name: 'New' },
						},
						carId: 'missing',
					}),
				],
			),
		).toEqual([]);
	});

	it('replays durable operations over canonical Cars after restart', () => {
		const operations: CarSyncOperation[] = [
			operation(),
			operation({
				operationId: 'operation-2',
				createdAt: '2026-08-11T10:02:00.000Z',
				command: {
					type: 'car.archive',
					carId: 'car-1',
					baseVersion: 3,
					base: { archivedAt: null },
				},
			}),
			operation({
				operationId: 'operation-3',
				carId: 'car-2',
				createdAt: '2026-08-11T10:03:00.000Z',
				command: {
					type: 'car.create',
					carId: 'car-2',
					car: { name: 'Cat L1R' },
				},
			}),
		];

		expect(materializeCars([car()], operations)).toEqual([
			expect.objectContaining({
				id: 'car-1',
				name: 'B7 club',
				archivedAt: '2026-08-11T10:02:00.000Z',
			}),
			expect.objectContaining({ id: 'car-2', name: 'Cat L1R', version: 0 }),
		]);
	});

	it('runs independent operations while blocked dependencies stay queued', () => {
		const blocked = operation({
			operationId: 'operation-blocked',
			dependencies: ['operation-attention'],
		});
		const attention = operation({
			operationId: 'operation-attention',
			status: 'needs-attention',
			feedback: {
				code: 'CAR_VALIDATION_FAILED',
				message: 'Car change needs attention',
			},
		});
		const independent = operation({
			operationId: 'operation-independent',
			carId: 'car-2',
			command: {
				type: 'car.create',
				carId: 'car-2',
				car: { name: 'Independent' },
			},
		});

		expect(
			readyCarSyncOperations([blocked, attention, independent]).map(
				(value) => value.operationId,
			),
		).toEqual(['operation-independent']);
	});

	it('prioritizes conflict, attention, syncing, and pending marks', () => {
		const pending = operation();
		expect(carSyncMark([pending], new Set())).toEqual({
			kind: 'pending',
			operationIds: ['operation-1'],
		});
		expect(carSyncMark([pending], new Set(['operation-1']))).toEqual({
			kind: 'syncing',
			operationIds: ['operation-1'],
		});
		const attention = operation({
			operationId: 'operation-attention',
			status: 'needs-attention',
			feedback: { code: 'INVALID', message: 'Fix this Car' },
		});
		expect(carSyncMark([pending, attention], new Set()).kind).toBe(
			'needs-attention',
		);
		const conflict = operation({
			operationId: 'operation-conflict',
			status: 'conflict',
			remote: car({ name: 'Remote B7', version: 4 }),
		});
		expect(carSyncMark([pending, attention, conflict], new Set()).kind).toBe(
			'conflict',
		);
		expect(carSyncMark([], new Set())).toEqual({ kind: 'synced' });
	});
});
