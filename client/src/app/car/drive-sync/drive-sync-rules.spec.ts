import { assert, describe, expect, it } from 'vitest';
import {
	applyDriveChange,
	buildDriveSyncOperation,
	materializeDriveCollections,
	mergeDriveCollection,
	readyDriveSyncOperations,
	rebaseDriveSyncOperation,
} from './drive-sync-rules';

const context = {
	ownerKey: 'owner',
	operationId: 'create',
	sessionId: 'drive',
	createdAt: '2026-10-09T12:00:00Z',
	carDependencies: ['car'],
};
const command = {
	action: 'save',
	carId: 'car',
	sessionId: null,
	input: {
		startedAt: context.createdAt,
		durationMinutes: 10,
		conditions: 'Dry',
		notes: 'Grip',
	},
} as const;
const create = () => buildDriveSyncOperation(command, [], [], context);
describe('durable Drive session intent', () => {
	it('replays creation, editing, and archival without duplicating usage', () => {
		const first = create();
		const firstSession = first.collection.sessions[0];
		assert(firstSession);
		const edit = buildDriveSyncOperation(
			{
				...command,
				sessionId: 'drive',
				input: { ...command.input, notes: 'Better grip' },
			},
			[first.collection],
			[first.operation],
			{ ...context, operationId: 'edit' },
		);
		const archived = buildDriveSyncOperation(
			{ ...command, action: 'archive', sessionId: 'drive' },
			[edit.collection],
			[first.operation, edit.operation],
			{ ...context, operationId: 'archive' },
		);
		expect(edit.operation.dependencies).toEqual(['car', 'create']);
		expect(archived.collection.sessions).toHaveLength(1);
		expect(archived.collection.sessions[0]?.deletedAt).toBe(context.createdAt);
		expect(
			materializeDriveCollections(
				[],
				[archived.operation, edit.operation, first.operation],
			),
		).toEqual([archived.collection]);
		expect(
			materializeDriveCollections([first.collection], [edit.operation]),
		).toEqual([edit.collection]);
		expect(
			applyDriveChange(
				{
					...first.collection,
					sessions: [
						...first.collection.sessions,
						{ ...firstSession, id: 'other' },
					],
				},
				edit.operation.command,
				context.createdAt,
			).sessions[1]?.id,
		).toBe('other');
	});
	it('waits only for required Car and session commands', () => {
		const first = create();
		const firstSession = first.collection.sessions[0];
		assert(firstSession);
		const second = buildDriveSyncOperation(
			command,
			[first.collection],
			[first.operation],
			{ ...context, operationId: 'second', sessionId: 'other' },
		);
		expect(second.operation.dependencies).toEqual(['car']);
		expect(
			readyDriveSyncOperations(
				[second.operation, first.operation],
				new Set(['car']),
			),
		).toEqual([]);
		expect(
			readyDriveSyncOperations([second.operation, first.operation], new Set()),
		).toEqual([first.operation, second.operation]);
		expect(
			readyDriveSyncOperations(
				[{ ...first.operation, status: 'needs-attention' }, second.operation],
				new Set(['create']),
			),
		).toEqual([second.operation]);
	});
	it('refuses missing and archived identities', () => {
		const first = create();
		const firstSession = first.collection.sessions[0];
		assert(firstSession);
		for (const invalid of [
			{ ...command, sessionId: 'missing' },
			{ ...command, action: 'archive' as const },
		])
			expect(() => buildDriveSyncOperation(invalid, [], [], context)).toThrow(
				'unavailable',
			);
		expect(() =>
			buildDriveSyncOperation(
				{ ...command, sessionId: 'drive' },
				[
					{
						...first.collection,
						sessions: [
							{
								...firstSession,
								deletedAt: context.createdAt,
							},
						],
					},
				],
				[],
				context,
			),
		).toThrow('archived');
	});
	it('rebases acknowledged dependencies while preserving independent intent and newer reads', () => {
		const first = create();
		const firstSession = first.collection.sessions[0];
		assert(firstSession);
		const current = {
			...first.collection,
			version: 8,
			timezone: 'America/New_York',
		};
		expect(
			rebaseDriveSyncOperation(first.operation, 'unrelated', current),
		).toBe(first.operation);
		expect(
			rebaseDriveSyncOperation(first.operation, 'car', current).command
				.baseVersion,
		).toBe(8);
		const edit = buildDriveSyncOperation(
			{ ...command, sessionId: 'drive' },
			[first.collection],
			[first.operation],
			{ ...context, operationId: 'edit' },
		);
		expect(
			rebaseDriveSyncOperation(edit.operation, 'create', current).command.base,
		).toEqual(current.sessions[0]);
		expect(
			rebaseDriveSyncOperation(edit.operation, 'create', {
				...current,
				sessions: [],
			}).command.base,
		).toEqual(edit.operation.command.base);
		expect(mergeDriveCollection([], first.collection)).toEqual([
			first.collection,
		]);
		expect(mergeDriveCollection([current], first.collection)).toEqual([
			current,
		]);
		const other = { carId: 'other', version: 0, sessions: [] };
		expect(
			mergeDriveCollection([{ ...current, version: 1 }], first.collection)[0]
				?.timezone,
		).toBe('America/New_York');
		expect(mergeDriveCollection([first.collection, other], current)).toEqual([
			current,
			other,
		]);
	});
});
