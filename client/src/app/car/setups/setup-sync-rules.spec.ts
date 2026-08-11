import { describe, expect, it } from 'vitest';
import type { SetupSnapshot } from './setup-snapshot';
import type {
	SetupSyncCollection,
	SetupSyncOperation,
} from './setup-sync.models';
import {
	buildSetupSyncOperation,
	materializeSetupCollections,
	readySetupSyncOperations,
	rebaseSetupSyncOperation,
	setupDraftFromSnapshot,
	setupSyncMark,
} from './setup-sync-rules';

const setup = (overrides: Partial<SetupSnapshot> = {}): SetupSnapshot => ({
	id: 'setup-1',
	carId: 'car-1',
	name: 'Clay baseline',
	status: 'active',
	current: true,
	context: {
		recordedAt: '2026-08-10T00:00:00.000Z',
		track: 'Nor-Cal',
		event: null,
		surface: 'Clay',
		traction: 'High',
		moisture: null,
		condition: 'Dry',
		temperature: null,
	},
	sections: {
		vehicle: { rideHeight: '13 mm' },
		drivetrain: {},
		electronics: {},
		tires: {},
		shocks: { frontOil: '40 wt' },
		frontSuspension: {},
		rearSuspension: {},
		notes: { setupNotes: 'Stable' },
	},
	source: {
		url: 'https://www.sodialed.com/setup/abc',
		pdfUrl: 'https://example.test/setup.pdf',
		pdfTitle: 'Original sheet',
		pdfPage: 2,
	},
	copiedFromSetupId: null,
	rawValues: { raw: true },
	unmappedValues: { unknown: 'value' },
	createdAt: '2026-08-10T10:00:00.000Z',
	updatedAt: '2026-08-10T10:00:00.000Z',
	version: 3,
	...overrides,
});

const collection = (
	overrides: Partial<SetupSyncCollection> = {},
): SetupSyncCollection => ({
	carId: 'car-1',
	currentSetupId: 'setup-1',
	currentSetupVersion: 4,
	setups: [setup()],
	...overrides,
});

const operation = (
	overrides: Partial<SetupSyncOperation> = {},
): SetupSyncOperation => ({
	operationId: 'operation-1',
	ownerKey: 'owner-1',
	carId: 'car-1',
	setupId: 'setup-2',
	command: {
		type: 'setup.create',
		carId: 'car-1',
		setupId: 'setup-2',
		copiedFromSetupId: 'setup-1',
		setup: { name: 'Copy' },
		makeCurrent: false,
		baseCurrent: null,
	},
	dependencies: [],
	status: 'pending',
	createdAt: '2026-08-11T10:00:00.000Z',
	sequence: 1,
	...overrides,
});

describe('Setup synchronization rules', () => {
	it('normalizes a snapshot into the complete immutable wire draft', () => {
		expect(setupDraftFromSnapshot(setup())).toEqual({
			name: 'Clay baseline',
			status: 'active',
			setupDate: '2026-08-10T00:00:00.000Z',
			track: 'Nor-Cal',
			event: null,
			surface: 'Clay',
			traction: 'High',
			moisture: null,
			condition: 'Dry',
			temperature: null,
			vehicle: { rideHeight: '13 mm' },
			drivetrain: {},
			electronics: {},
			tires: {},
			shocks: { frontOil: '40 wt' },
			frontSuspension: {},
			rearSuspension: {},
			notes: 'Stable',
			sourceUrl: 'https://www.sodialed.com/setup/abc',
			sourcePdfReference: 'Original sheet',
			sourceMetadata: {
				pdfUrl: 'https://example.test/setup.pdf',
				pdfPage: 2,
			},
			rawValues: { raw: true },
			unmappedValues: { unknown: 'value' },
		});
		expect(
			setupDraftFromSnapshot(
				setup({ status: undefined, context: null, source: null }),
			),
		).toMatchObject({
			status: 'active',
			setupDate: null,
			sourceMetadata: null,
		});
	});

	it('builds stable add, copy, change, correction, and selection operations', () => {
		const add = buildSetupSyncOperation(
			{
				type: 'create',
				carId: 'car-1',
				draft: {
					name: 'First local setup',
					makeCurrent: true,
					sourceMetadata: { pdfUrl: 4, pdfPage: 'bad' },
				},
			},
			[],
			[],
			{
				ownerKey: 'owner-1',
				operationId: 'operation-add',
				setupId: 'setup-add',
				createdAt: '2026-08-11T10:00:00.000Z',
				carDependencies: ['car-create'],
			},
		);
		expect(add.operation).toMatchObject({
			setupId: 'setup-add',
			dependencies: ['car-create'],
			command: {
				type: 'setup.create',
				makeCurrent: true,
				baseCurrent: { setupId: null, version: 0 },
			},
		});
		expect(add.setup).toMatchObject({
			id: 'setup-add',
			current: true,
			version: 0,
			source: { pdfUrl: null, pdfPage: null },
		});

		const copy = buildSetupSyncOperation(
			{ type: 'copy', carId: 'car-1', setupId: 'setup-1' },
			[collection()],
			[add.operation],
			{
				ownerKey: 'owner-1',
				operationId: 'operation-copy',
				setupId: 'setup-copy',
				createdAt: '2026-08-11T10:01:00.000Z',
			},
		);
		expect(copy.operation).toMatchObject({
			dependencies: ['operation-add'],
			sequence: 2,
			command: {
				type: 'setup.create',
				copiedFromSetupId: 'setup-1',
				makeCurrent: false,
				baseCurrent: null,
			},
		});
		expect(copy.setup.current).toBe(false);

		const change = buildSetupSyncOperation(
			{
				type: 'change',
				carId: 'car-1',
				setupId: 'setup-1',
				draft: { name: 'Main final', shocks: { frontOil: '42.5 wt' } },
			},
			[collection()],
			[],
			{
				ownerKey: 'owner-1',
				operationId: 'operation-change',
				setupId: 'setup-change',
				createdAt: '2026-08-11T10:02:00.000Z',
			},
		);
		expect(change.operation.command).toMatchObject({
			type: 'setup.create',
			copiedFromSetupId: 'setup-1',
			makeCurrent: true,
			baseCurrent: { setupId: 'setup-1', version: 4 },
		});
		expect(change.collection.currentSetupId).toBe('setup-change');
		expect(
			change.collection.setups.find((value) => value.id === 'setup-1'),
		).toMatchObject({ current: false });

		const correct = buildSetupSyncOperation(
			{
				type: 'correct',
				carId: 'car-1',
				setupId: 'setup-1',
				draft: {
					...setupDraftFromSnapshot(setup()),
					name: 'Corrected baseline',
					vehicle: { rideHeight: '13 mm' },
				},
			},
			[collection()],
			[],
			{
				ownerKey: 'owner-1',
				operationId: 'operation-correct',
				createdAt: '2026-08-11T10:03:00.000Z',
			},
		);
		expect(correct.operation.command).toEqual({
			type: 'setup.correct',
			carId: 'car-1',
			setupId: 'setup-1',
			baseVersion: 3,
			base: { name: 'Clay baseline' },
			changes: { name: 'Corrected baseline' },
		});
		expect(correct.setup).toMatchObject({
			name: 'Corrected baseline',
			version: 3,
			current: true,
		});

		const select = buildSetupSyncOperation(
			{ type: 'select-current', carId: 'car-1', setupId: 'setup-2' },
			[
				collection({
					setups: [setup(), setup({ id: 'setup-2', current: false })],
				}),
			],
			[],
			{
				ownerKey: 'owner-1',
				operationId: 'operation-select',
				createdAt: '2026-08-11T10:04:00.000Z',
			},
		);
		expect(select.operation.command).toEqual({
			type: 'setup.select-current',
			carId: 'car-1',
			setupId: 'setup-2',
			baseCurrent: { setupId: 'setup-1', version: 4 },
		});
		expect(select.collection.currentSetupId).toBe('setup-2');
	});

	it('rejects commands without their required local identity or source', () => {
		expect(() =>
			buildSetupSyncOperation(
				{ type: 'create', carId: 'car-1', draft: { name: 'No ID' } },
				[],
				[],
				{
					ownerKey: 'owner-1',
					operationId: 'operation-1',
					createdAt: '2026-08-11T10:00:00.000Z',
				},
			),
		).toThrow('stable Setup identity');
		expect(() =>
			buildSetupSyncOperation(
				{ type: 'copy', carId: 'car-1', setupId: 'missing' },
				[collection()],
				[],
				{
					ownerKey: 'owner-1',
					operationId: 'operation-1',
					createdAt: '2026-08-11T10:00:00.000Z',
				},
			),
		).toThrow('Setup not found');
		expect(() =>
			buildSetupSyncOperation(
				{
					type: 'correct',
					carId: 'car-1',
					setupId: 'setup-1',
					draft: setupDraftFromSnapshot(setup()),
				},
				[collection()],
				[],
				{
					ownerKey: 'owner-1',
					operationId: 'operation-1',
					createdAt: '2026-08-11T10:00:00.000Z',
				},
			),
		).toThrow('correction');
	});

	it('materializes ordered work without overwriting immutable history', () => {
		const create = operation({ sequence: 2 });
		const correction = operation({
			operationId: 'operation-correct',
			setupId: 'setup-1',
			sequence: 1,
			command: {
				type: 'setup.correct',
				carId: 'car-1',
				setupId: 'setup-1',
				baseVersion: 3,
				base: { name: 'Clay baseline' },
				changes: { name: 'Corrected' },
			},
		});
		const selected = operation({
			operationId: 'operation-select',
			setupId: 'setup-2',
			sequence: 3,
			command: {
				type: 'setup.select-current',
				carId: 'car-1',
				setupId: 'setup-2',
				baseCurrent: { setupId: 'setup-1', version: 4 },
			},
		});
		const [view] = materializeSetupCollections(
			[collection()],
			[selected, create, correction],
		);
		expect(view?.setups).toHaveLength(2);
		expect(view?.setups.find((value) => value.id === 'setup-1')).toMatchObject({
			name: 'Corrected',
			current: false,
		});
		expect(view?.setups.find((value) => value.id === 'setup-2')).toMatchObject({
			name: 'Copy',
			current: true,
		});
		expect(
			materializeSetupCollections(
				[],
				[
					operation({
						command: {
							type: 'setup.correct',
							carId: 'car-1',
							setupId: 'missing',
							baseVersion: 0,
							base: { name: null },
							changes: { name: 'Missing' },
						},
					}),
				],
			)[0]?.setups,
		).toEqual([]);
	});

	it('releases only ready operations and rebases dependent commands', () => {
		const blocked = operation({ dependencies: ['car-create'] });
		const ready = operation({
			operationId: 'operation-ready',
			createdAt: '2026-08-11T09:00:00.000Z',
			sequence: 2,
		});
		const attention = operation({
			operationId: 'operation-attention',
			status: 'needs-attention',
			sequence: 3,
		});
		expect(
			readySetupSyncOperations(
				[blocked, attention, ready],
				new Set(['car-create']),
			),
		).toEqual([ready]);

		const selected = operation({
			dependencies: ['operation-parent', 'car-create'],
			command: {
				type: 'setup.select-current',
				carId: 'car-1',
				setupId: 'setup-2',
				baseCurrent: { setupId: 'setup-1', version: 2 },
			},
		});
		expect(
			rebaseSetupSyncOperation(
				selected,
				'operation-parent',
				collection({ currentSetupId: 'setup-2', currentSetupVersion: 5 }),
			),
		).toMatchObject({
			dependencies: ['car-create'],
			command: { baseCurrent: { setupId: 'setup-2', version: 5 } },
		});

		const create = operation({
			dependencies: ['operation-parent'],
			command: {
				...(operation().command as Extract<
					SetupSyncOperation['command'],
					{ type: 'setup.create' }
				>),
				makeCurrent: true,
				baseCurrent: { setupId: 'setup-1', version: 2 },
			},
		});
		const createCommand = create.command as Extract<
			SetupSyncOperation['command'],
			{ type: 'setup.create' }
		>;
		expect(
			rebaseSetupSyncOperation(create, 'operation-parent', collection()),
		).toMatchObject({
			dependencies: [],
			command: { baseCurrent: { setupId: 'setup-1', version: 4 } },
		});
		expect(
			rebaseSetupSyncOperation(
				{
					...create,
					command: { ...createCommand, makeCurrent: false },
				},
				'operation-parent',
				collection(),
			),
		).toMatchObject({ command: { baseCurrent: null } });

		const correction = operation({
			setupId: 'setup-1',
			dependencies: ['operation-parent'],
			command: {
				type: 'setup.correct',
				carId: 'car-1',
				setupId: 'setup-1',
				baseVersion: 1,
				base: { name: 'Old' },
				changes: { name: 'Corrected' },
			},
		});
		expect(
			rebaseSetupSyncOperation(correction, 'operation-parent', collection()),
		).toMatchObject({
			dependencies: [],
			command: { baseVersion: 3, base: { name: 'Clay baseline' } },
		});
		expect(
			rebaseSetupSyncOperation(
				correction,
				'operation-parent',
				collection({ setups: [] }),
			),
		).toMatchObject({ dependencies: [] });
		expect(
			rebaseSetupSyncOperation(correction, 'unrelated', collection()),
		).toBe(correction);
	});

	it('orders deterministic ties and rebases nullable correction bases', () => {
		const tied = [
			operation({
				operationId: 'operation-c',
				createdAt: '2026-08-11T10:00:00.000Z',
				sequence: 1,
			}),
			operation({
				operationId: 'operation-b',
				createdAt: '2026-08-11T09:00:00.000Z',
				sequence: 1,
			}),
			operation({
				operationId: 'operation-a',
				createdAt: '2026-08-11T10:00:00.000Z',
				sequence: 1,
			}),
		];
		expect(
			readySetupSyncOperations(tied, new Set()).map(
				(candidate) => candidate.operationId,
			),
		).toEqual(['operation-b', 'operation-a', 'operation-c']);

		const nullableSetup = setup({
			createdAt: undefined,
			version: undefined,
			context: { event: null },
			rawValues: { nested: [1, { key: 'value' }] },
			source: { url: 'https://example.test/setup' },
		});
		expect(setupDraftFromSnapshot(nullableSetup).sourceMetadata).toEqual({
			pdfUrl: null,
			pdfPage: null,
		});
		const corrected = buildSetupSyncOperation(
			{
				type: 'correct',
				carId: 'car-1',
				setupId: 'setup-1',
				draft: {
					name: 'Corrected setup',
					event: 'Club night',
					rawValues: { nested: [1, { key: 'value' }] },
				},
			},
			[collection({ setups: [nullableSetup, setup({ id: 'setup-other' })] })],
			[],
			{
				ownerKey: 'owner-1',
				operationId: 'operation-nullable',
				createdAt: '2026-08-11T11:00:00.000Z',
			},
		);
		expect(corrected.operation.command).toMatchObject({
			baseVersion: 0,
			base: { event: null },
			changes: { event: 'Club night' },
		});
		expect(corrected.setup.createdAt).toBe('2026-08-11T11:00:00.000Z');

		const rebased = rebaseSetupSyncOperation(
			{
				...corrected.operation,
				dependencies: ['operation-parent'],
				command: {
					...(corrected.operation.command as Extract<
						SetupSyncOperation['command'],
						{ type: 'setup.correct' }
					>),
					base: { event: null },
				},
			},
			'operation-parent',
			collection({ setups: [nullableSetup] }),
		);
		expect(rebased.command).toMatchObject({
			baseVersion: 0,
			base: { event: null },
		});
	});

	it('publishes the highest-priority synchronization mark', () => {
		expect(setupSyncMark([], new Set())).toEqual({ kind: 'synced' });
		expect(setupSyncMark([operation()], new Set())).toEqual({
			kind: 'pending',
			operationIds: ['operation-1'],
		});
		expect(setupSyncMark([operation()], new Set(['operation-1']))).toEqual({
			kind: 'syncing',
			operationIds: ['operation-1'],
		});
		const feedback = { code: 'INVALID', message: 'Review the setup' };
		expect(
			setupSyncMark(
				[
					operation({
						status: 'needs-attention',
						feedback,
					}),
				],
				new Set(),
			),
		).toEqual({
			kind: 'needs-attention',
			operationId: 'operation-1',
			feedback,
		});
		const remote = {
			currentSetupId: 'setup-remote',
			currentSetupVersion: 6,
			setup: setup({ id: 'setup-remote' }),
		};
		expect(
			setupSyncMark(
				[
					operation({
						status: 'conflict',
						remote,
					}),
				],
				new Set(),
			),
		).toEqual({
			kind: 'conflict',
			operationId: 'operation-1',
			remote,
		});
	});
});
