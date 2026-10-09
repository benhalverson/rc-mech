import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
	afterEach,
	assert,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	CarWorkspaceStore,
	type DriveWorkspaceMutationOutcome,
} from '../../garage/car-sync/car-workspace-store';
import type {
	DriveSyncCollection,
	DriveSyncCommand,
	DriveSyncOperation,
} from '../drive-sync/drive-sync.models';
import { DriveSessionGateway } from './drive-session-gateway';
import { DriveSessionStore } from './drive-session-store';

const input = {
	startedAt: '2026-10-09T12:00:00Z',
	durationMinutes: 10,
	conditions: 'Dry',
	notes: 'Grip',
};
const session = { id: 'drive', carId: 'car', ...input, deletedAt: null };
class Workspace {
	readonly opened = signal(true);
	readonly durableSetupMutationsAvailable = signal(true);
	readonly driveCollections = signal<readonly DriveSyncCollection[]>([
		{ carId: 'other', version: 1, sessions: [] },
		{ carId: 'car', version: 1, sessions: [session] },
	]);
	readonly driveOperations = signal<readonly DriveSyncOperation[]>([]);
	readonly driveMutationOutcome = signal<DriveWorkspaceMutationOutcome>({
		status: 'idle',
		requestId: null,
	});
	readonly commitDrive = vi.fn((_command: DriveSyncCommand) => undefined);
}
describe('Drive session local working copy', () => {
	let store: InstanceType<typeof DriveSessionStore>;
	let workspace: Workspace;
	beforeEach(() => {
		workspace = new Workspace();
		TestBed.configureTestingModule({
			providers: [
				DriveSessionStore,
				{ provide: CarWorkspaceStore, useValue: workspace },
				{
					provide: DriveSessionGateway,
					useValue: {
						collection: { hasValue: () => false, isLoading: () => true },
						timezone: { hasValue: () => false },
						collectionFailure: () => ({ kind: 'unavailable' }),
						selectCar: vi.fn(),
					},
				},
			],
		});
		store = TestBed.inject(DriveSessionStore);
		store.selectCar('car');
		TestBed.tick();
	});
	afterEach(() => TestBed.resetTestingModule());
	const save = () => ({ carId: 'car', sessionId: null, draft: input });
	const command = () => {
		const call = workspace.commitDrive.mock.calls.at(-1);
		assert(call);
		return call[0];
	};
	const succeed = (sessions = [session]) =>
		workspace.driveMutationOutcome.set({
			status: 'succeeded',
			requestId: 1,
			command: command(),
			operationId: 'op',
			collection: { carId: 'car', version: 2, sessions },
		});
	it('reads local history and usage despite an unavailable server', () => {
		expect(store.sessions()).toEqual([session]);
		expect(store.activeCount()).toBe(1);
		expect(store.loading()).toBe(false);
		expect(store.failure()).toBeNull();
		workspace.driveCollections.set([
			{
				carId: 'car',
				version: 1,
				sessions: [session],
				timezone: 'America/New_York',
			},
		]);
		expect(store.timezone()).toBe('America/New_York');
	});
	it('reports success only after durable commit and tracks its own pending operation', () => {
		store.saveDriveSession({ ...save(), carId: '' });
		store.saveDriveSession({ ...save(), carId: 'other' });
		expect(workspace.commitDrive).not.toHaveBeenCalled();
		store.saveDriveSession(save());
		store.saveDriveSession(save());
		expect(workspace.commitDrive).toHaveBeenCalledOnce();
		expect(store.pending()).toBe(true);
		workspace.driveMutationOutcome.set({
			status: 'pending',
			requestId: 1,
			command: { ...command() },
		});
		TestBed.tick();
		expect(store.pending()).toBe(true);
		workspace.driveMutationOutcome.set({
			status: 'pending',
			requestId: 1,
			command: command(),
		});
		TestBed.tick();
		expect(store.pending()).toBe(true);
		succeed([]);
		TestBed.tick();
		expect(store.pending()).toBe(true);
		succeed();
		TestBed.tick();
		expect(store.outcome()).toMatchObject({ status: 'succeeded', session });
		const operation: DriveSyncOperation = {
			operationId: 'op',
			ownerKey: 'owner',
			carId: 'car',
			command: {
				...command(),
				type: 'drive.change',
				sessionId: 'drive',
				base: null,
				baseVersion: 1,
			},
			dependencies: [],
			status: 'pending',
			sequence: 1,
			createdAt: input.startedAt,
		};
		workspace.driveOperations.set([
			operation,
			{ ...operation, operationId: 'other', carId: 'other' },
		]);
		expect(store.localPending()).toBe(true);
		expect(store.syncOperations()).toEqual([operation]);
		workspace.driveOperations.set([]);
		expect(store.localPending()).toBe(false);
	});
	it('retains local storage errors and ignores stale commands after navigation', () => {
		store.saveDriveSession(save());
		workspace.driveMutationOutcome.set({
			status: 'failed',
			requestId: 1,
			command: command(),
			error: { kind: 'local', message: 'Storage full' },
		});
		TestBed.tick();
		expect(store.error()).toBe('Storage full');
		store.saveDriveSession(save());
		store.selectCar('other');
		succeed();
		TestBed.tick();
		expect(store.outcome().status).toBe('idle');
	});
	it('archives the selected working copy including optional fields', () => {
		store.archiveDriveSession({ carId: 'car', sessionId: 'missing' });
		expect(workspace.commitDrive).not.toHaveBeenCalled();
		store.archiveDriveSession({ carId: 'car', sessionId: 'drive' });
		expect(command()).toMatchObject({ action: 'archive', input });
		succeed();
		TestBed.tick();
		expect(store.outcome().status).toBe('succeeded');
		workspace.driveCollections.set([
			{
				carId: 'car',
				version: 2,
				sessions: [{ ...session, conditions: null, notes: null }],
			},
		]);
		store.archiveDriveSession({ carId: 'car', sessionId: 'drive' });
		expect(command().input).toMatchObject({ conditions: '', notes: '' });
	});
});
