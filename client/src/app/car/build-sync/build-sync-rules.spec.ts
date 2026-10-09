import { describe, expect, it } from 'vitest';
import type {
	BuildSyncCollection,
	BuildSyncOperation,
} from './build-sync.models';
import {
	applyBuildChange,
	buildBuildSyncOperation,
	materializeBuildCollections,
	mergeBuildCollection,
	readyBuildSyncOperations,
	rebaseBuildSyncOperation,
} from './build-sync-rules';

const context = {
	ownerKey: 'owner',
	operationId: 'install',
	componentId: 'motor',
	createdAt: '2026-10-09T12:00:00Z',
	carDependencies: ['car-create'],
};
const install = () =>
	buildBuildSyncOperation(
		{
			action: 'install',
			carId: 'car',
			componentId: null,
			input: { slot: 'motor', slotType: 'standard', name: 'Stock motor' },
		},
		[],
		[],
		context,
	);

describe('durable build intent', () => {
	it('preserves installation, edit, replacement, and removal through replay', () => {
		const first = install();
		const edited = buildBuildSyncOperation(
			{
				action: 'edit',
				carId: 'car',
				componentId: 'motor',
				input: { name: 'Tuned motor' },
			},
			[first.collection],
			[first.operation],
			{ ...context, operationId: 'edit' },
		);
		const replacement = buildBuildSyncOperation(
			{
				action: 'replace',
				carId: 'car',
				componentId: 'motor',
				input: { slot: 'motor', name: 'New motor' },
			},
			[edited.collection],
			[first.operation, edited.operation],
			{ ...context, operationId: 'replace', componentId: 'new-motor' },
		);
		const removed = buildBuildSyncOperation(
			{
				action: 'remove',
				carId: 'car',
				componentId: 'new-motor',
				input: { name: 'New motor' },
			},
			[replacement.collection],
			[first.operation, edited.operation, replacement.operation],
			{ ...context, operationId: 'remove' },
		);
		expect(first.operation.dependencies).toEqual(['car-create']);
		expect(edited.operation.command.base?.name).toBe('Stock motor');
		expect(replacement.operation.dependencies).toContain('install');
		expect(
			removed.collection.components.every((component) => component.removedAt),
		).toBe(true);
		const operations = [
			removed.operation,
			replacement.operation,
			edited.operation,
			first.operation,
		];
		expect(materializeBuildCollections([], operations)).toEqual([
			removed.collection,
		]);
		expect(
			materializeBuildCollections([first.collection], [edited.operation])[0]
				?.components[0]?.name,
		).toBe('Tuned motor');
	});

	it('keeps different slots independent while waiting for their Car', () => {
		const first = install();
		const second = buildBuildSyncOperation(
			{
				action: 'install',
				carId: 'car',
				componentId: null,
				input: { slot: 'esc', name: 'Speed controller' },
			},
			[first.collection],
			[first.operation],
			{ ...context, operationId: 'esc', componentId: 'esc' },
		);
		expect(second.operation.dependencies).toEqual(['car-create']);
		expect(
			readyBuildSyncOperations(
				[second.operation, first.operation],
				new Set(['car-create']),
			),
		).toEqual([]);
		expect(
			readyBuildSyncOperations([second.operation, first.operation], new Set()),
		).toEqual([first.operation, second.operation]);
		const rejected: BuildSyncOperation = {
			...first.operation,
			status: 'needs-attention',
		};
		expect(
			readyBuildSyncOperations(
				[rejected, second.operation],
				new Set(['install']),
			),
		).toEqual([second.operation]);
	});

	it('retains unknown optional historical fields and immutable replacement history', () => {
		const collection: BuildSyncCollection = {
			carId: 'car',
			version: 3,
			components: [
				{
					id: 'old',
					carId: 'car',
					slot: 'motor',
					name: 'Old',
					removedAt: '2020-01-01',
				},
				{ id: 'current', carId: 'car', slot: 'motor', name: 'Current' },
			],
		};
		const updated = buildBuildSyncOperation(
			{
				action: 'install',
				carId: 'car',
				componentId: null,
				input: { slot: 'motor', name: 'Next' },
			},
			[collection],
			[],
			context,
		);
		expect(updated.operation.command.base).toMatchObject({
			id: 'current',
			slotType: 'custom',
			manufacturer: null,
			installedAt: context.createdAt,
		});
		expect(updated.collection.components[0]).toBe(collection.components[0]);
		const specified = applyBuildChange(
			{ carId: 'car', version: 0, components: [] },
			{
				...updated.operation.command,
				input: {
					...updated.operation.command.input,
					installedAt: '2026-01-01',
					manufacturer: 'Maker',
					model: 'Model',
					serialNumber: 'Serial',
					notes: 'Notes',
				},
			},
			context.createdAt,
		);
		expect(specified.components[0]).toMatchObject({
			installedAt: '2026-01-01',
			manufacturer: 'Maker',
		});
	});

	it('rejects unavailable identities and missing slots before local success', () => {
		expect(() =>
			buildBuildSyncOperation(
				{
					action: 'edit',
					carId: 'car',
					componentId: 'missing',
					input: { name: 'Changed' },
				},
				[],
				[],
				context,
			),
		).toThrow('unavailable');
		expect(() =>
			buildBuildSyncOperation(
				{
					action: 'install',
					carId: 'car',
					componentId: null,
					input: { name: 'Missing slot' },
				},
				[],
				[],
				context,
			),
		).toThrow('slot');
	});

	it('rebases only acknowledged dependencies and never regresses canonical reads', () => {
		const first = install();
		const current = { ...first.collection, version: 5 };
		expect(
			rebaseBuildSyncOperation(first.operation, 'unrelated', current),
		).toBe(first.operation);
		expect(
			rebaseBuildSyncOperation(first.operation, 'car-create', current).command
				.baseVersion,
		).toBe(5);
		const edited = buildBuildSyncOperation(
			{
				action: 'edit',
				carId: 'car',
				componentId: 'motor',
				input: { name: 'Tuned' },
			},
			[first.collection],
			[first.operation],
			{ ...context, operationId: 'edit' },
		);
		expect(
			rebaseBuildSyncOperation(edited.operation, 'install', current).command
				.base,
		).toEqual(current.components[0]);
		expect(
			rebaseBuildSyncOperation(edited.operation, 'install', {
				...current,
				components: [],
			}).command.base,
		).toEqual(edited.operation.command.base);
		expect(mergeBuildCollection([], first.collection)).toEqual([
			first.collection,
		]);
		expect(mergeBuildCollection([current], first.collection)).toEqual([
			current,
		]);
		const other = { carId: 'other', version: 0, components: [] };
		expect(mergeBuildCollection([first.collection, other], current)).toEqual([
			current,
			other,
		]);
	});
});
