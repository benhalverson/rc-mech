import { TestBed } from '@angular/core/testing';
import Dexie from 'dexie';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SetupSnapshot } from '../car/setups/setup-snapshot';
import type {
	SetupSyncCollection,
	SetupSyncOperation,
} from '../car/setups/setup-sync.models';
import type { CarSyncRemoteOutcome } from '../garage/car-sync/car-sync.models';
import type { GarageCar } from '../garage/garage.models';
import {
	OFFLINE_CURRENT_TIME,
	OFFLINE_DATABASE_NAME,
	OFFLINE_OPERATION_ID,
	OFFLINE_OWNER_FENCE_STORAGE,
	OFFLINE_SIGN_OUT_LEASE_MS,
	OfflineGarageStorage,
	type OfflineOwnerFenceStorage,
	offlineCurrentTime,
	offlineCurrentTimeProvider,
	offlineDatabaseName,
	offlineOperationId,
	offlineOperationIdProvider,
	offlineOwnerFenceKey,
	offlineOwnerFenceStorage,
} from './offline-garage-storage';

const car = (id: string, name: string): GarageCar => ({ id, name });
const userAFence = { ownerKey: 'user-a', sessionKey: 'session-a' } as const;
const setup = (overrides: Partial<SetupSnapshot> = {}): SetupSnapshot => ({
	id: 'setup-1',
	carId: 'car-a',
	name: 'Baseline',
	current: true,
	sections: {
		vehicle: {},
		drivetrain: {},
		electronics: {},
		tires: {},
		shocks: {},
		frontSuspension: {},
		rearSuspension: {},
		notes: {},
	},
	createdAt: '2026-08-10T12:00:00.000Z',
	updatedAt: '2026-08-10T12:00:00.000Z',
	version: 1,
	...overrides,
});
const setupCollection = (
	overrides: Partial<SetupSyncCollection> = {},
): SetupSyncCollection => ({
	carId: 'car-a',
	currentSetupId: 'setup-1',
	currentSetupVersion: 1,
	setups: [setup()],
	...overrides,
});

describe('OfflineGarageStorage', () => {
	let storage: OfflineGarageStorage;
	let databaseName: string;
	let ownerFence: Map<string, string>;
	let fenceFailure: 'get' | 'remove' | 'set' | null;
	let concurrentFence: string | null;
	let currentTime: number;
	let operationNumber: number;

	beforeEach(() => {
		Dexie.dependencies.indexedDB = indexedDB;
		Dexie.dependencies.IDBKeyRange = IDBKeyRange;
		databaseName = `offline-garage-${crypto.randomUUID()}`;
		ownerFence = new Map();
		fenceFailure = null;
		concurrentFence = null;
		currentTime = Date.parse('2026-08-11T12:00:00.000Z');
		operationNumber = 0;
		TestBed.configureTestingModule({
			providers: [
				OfflineGarageStorage,
				{ provide: OFFLINE_DATABASE_NAME, useValue: databaseName },
				{ provide: OFFLINE_CURRENT_TIME, useValue: () => currentTime },
				{
					provide: OFFLINE_OPERATION_ID,
					useValue: () => `operation-${++operationNumber}`,
				},
				{
					provide: OFFLINE_OWNER_FENCE_STORAGE,
					useValue: {
						getItem: (key: string) => {
							if (fenceFailure === 'get') throw new Error('Fence unavailable');
							const current = ownerFence.get(key) ?? null;
							if (
								concurrentFence &&
								current?.includes('"sessionKey":"session-a"')
							) {
								ownerFence.set(key, concurrentFence);
								const replacement = concurrentFence;
								concurrentFence = null;
								return replacement;
							}
							return current;
						},
						removeItem: (key: string) => {
							if (fenceFailure === 'remove')
								throw new Error('Fence unavailable');
							ownerFence.delete(key);
						},
						setItem: (key: string, value: string) => {
							if (fenceFailure === 'set') throw new Error('Fence unavailable');
							ownerFence.set(key, value);
						},
					},
				},
			],
		});
		storage = TestBed.inject(OfflineGarageStorage);
	});

	afterEach(async () => {
		storage.close();
		await Dexie.delete(databaseName);
		TestBed.resetTestingModule();
	});

	it('keeps only the active User Garage snapshot', async () => {
		expect(offlineDatabaseName()).toBe('chassis-notes-offline-v1');
		expect(offlineCurrentTime()).toEqual(expect.any(Number));
		expect(offlineCurrentTimeProvider()).toBe(offlineCurrentTime);
		expect(offlineOperationId()).toEqual(expect.any(String));
		expect(offlineOperationIdProvider()).toBe(offlineOperationId);
		expect(offlineOwnerFenceStorage()).toBe(globalThis.localStorage);
		expect(offlineOwnerFenceStorage({})).toBeNull();
		expect(
			offlineOwnerFenceStorage({
				get localStorage(): OfflineOwnerFenceStorage {
					throw new Error('Storage blocked');
				},
			}),
		).toBeNull();
		expect(
			await storage.restoreCurrent(new Date('2026-08-11T12:00:00.000Z')),
		).toBeNull();
		await storage.deactivate();

		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(true);
		await expect(
			storage.save(
				{
					ownerKey: 'user-a',
					ownerEmail: 'a@example.test',
					offlineUntil: '2026-08-12T12:00:00.000Z',
					preparedAt: '2026-08-11T12:00:00.000Z',
					cars: [car('car-a', 'Buggy A')],
				},
				'session-a',
			),
		).resolves.toBe(true);
		await expect(storage.activate('user-b', 'session-b')).resolves.toBe(true);
		await expect(
			storage.save(
				{
					ownerKey: 'user-b',
					ownerEmail: 'b@example.test',
					offlineUntil: '2026-08-12T12:00:00.000Z',
					preparedAt: '2026-08-11T12:01:00.000Z',
					cars: [car('car-b', 'Buggy B')],
				},
				'session-b',
			),
		).resolves.toBe(true);

		expect(await storage.read('user-a')).toBeNull();
		expect(
			await storage.restoreCurrent(new Date('2026-08-11T12:02:00.000Z')),
		).toMatchObject({
			ownerKey: 'user-b',
			cars: [{ id: 'car-b', name: 'Buggy B' }],
		});
		const signOutOperation = await storage.deactivate();
		expect(await storage.read('user-b')).toBeNull();
		expect(await storage.read('user-a')).toBeNull();

		await storage.completeSignOut(signOutOperation);
		await storage.activate('user-without-a-snapshot', 'session-c');
		expect(
			await storage.restoreCurrent(new Date('2026-08-11T12:02:00.000Z')),
		).toBeNull();
	});

	it('refuses a stale preparation after another User becomes active', async () => {
		await storage.activate('user-a', 'session-a');
		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(true);
		await storage.activate('user-b', 'session-b');
		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(false);
		await expect(
			storage.save(
				{
					ownerKey: 'user-a',
					ownerEmail: 'a@example.test',
					offlineUntil: '2026-08-12T12:00:00.000Z',
					preparedAt: '2026-08-11T12:00:00.000Z',
					cars: [car('car-a', 'Buggy A')],
				},
				'session-a',
			),
		).resolves.toBe(false);
		expect(await storage.read('user-a')).toBeNull();
	});

	it('refuses to restore a Garage after the server session expiry', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-11T12:00:00.000Z',
				preparedAt: '2026-08-11T11:00:00.000Z',
				cars: [car('car-a', 'Buggy A')],
			},
			'session-a',
		);

		expect(
			await storage.restoreCurrent(new Date('2026-08-11T12:00:00.000Z')),
		).toBeNull();
		expect(await storage.read('missing-user')).toBeNull();
	});

	it('fences the signed-out session across tabs until a new session starts', async () => {
		await storage.activate('user-a', 'session-a');
		const signOutOperation = await storage.deactivate('session-a');

		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(false);
		await expect(storage.activate('user-b', 'session-b')).resolves.toBe(false);
		await expect(storage.restoreCurrent()).resolves.toBeNull();
		await storage.completeSignOut(signOutOperation);
		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(false);
		await expect(storage.activate('user-a', 'session-b')).resolves.toBe(true);
		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(false);
		await storage.completeSignOut('missing-operation');
		await expect(storage.restoreCurrent()).resolves.toBeNull();
	});

	it('recovers an interrupted sign-out for a different verified session', async () => {
		await storage.activate('user-a', 'session-a');
		const signOutOperation = await storage.deactivate('session-a');
		currentTime += OFFLINE_SIGN_OUT_LEASE_MS + 1;

		await expect(storage.activate('user-b', 'session-b')).resolves.toBe(true);
		await storage.save(
			{
				ownerKey: 'user-b',
				ownerEmail: 'b@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:01:00.000Z',
				cars: [car('car-b', 'Buggy B')],
			},
			'session-b',
		);
		await storage.completeSignOut(signOutOperation);
		await expect(storage.restoreCurrent()).resolves.toMatchObject({
			ownerKey: 'user-b',
		});
		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(false);
	});

	it('revokes sign-out session identity before any snapshot is active', async () => {
		const signOutOperation = await storage.deactivate('session-a');
		await storage.completeSignOut(signOutOperation);

		await expect(storage.activate('user-b', 'session-b')).resolves.toBe(true);
		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(false);
	});

	it('revokes both a stale active session and the supplied current session', async () => {
		await storage.activate('user-a', 'session-a');
		const signOutOperation = await storage.deactivate('session-b');
		await storage.completeSignOut(signOutOperation);

		await expect(storage.activate('user-c', 'session-c')).resolves.toBe(true);
		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(false);
		await expect(storage.activate('user-b', 'session-b')).resolves.toBe(false);
	});

	it('does not roll back a newer tab fence after rejecting a stale session', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.activate('user-b', 'session-b');
		const newerFence = JSON.stringify({
			ownerKey: 'user-c',
			sessionKey: 'session-c',
		});
		concurrentFence = newerFence;

		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(false);
		expect(ownerFence.get(offlineOwnerFenceKey(databaseName))).toBe(newerFence);
	});

	it('refuses to restore an active snapshot when its browser owner fence is absent', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [car('car-a', 'Buggy A')],
			},
			'session-a',
		);
		ownerFence.delete(offlineOwnerFenceKey(databaseName));

		await expect(storage.restoreCurrent()).resolves.toBeNull();
		await expect(storage.read('user-a')).resolves.toMatchObject({
			ownerKey: 'user-a',
		});
		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(true);
	});

	it('rejects the prior User when a new owner transition cannot finish', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [car('car-a', 'Buggy A')],
			},
			'session-a',
		);
		const fenceKey = offlineOwnerFenceKey(databaseName);
		for (const value of [
			JSON.stringify({ ownerKey: 'user-b', sessionKey: 'session-b' }),
			JSON.stringify({ ownerKey: 'user-a', sessionKey: 'session-b' }),
			JSON.stringify({ ownerKey: 'user-a' }),
			JSON.stringify({}),
			'null',
			'{invalid',
		]) {
			ownerFence.set(fenceKey, value);
			await expect(storage.restoreCurrent()).resolves.toBeNull();
		}
	});

	it('invalidates the prior User when owner-fence storage fails', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [car('car-a', 'Buggy A')],
			},
			'session-a',
		);
		fenceFailure = 'set';
		await expect(storage.activate('user-b', 'session-b')).rejects.toThrow(
			'Fence unavailable',
		);
		fenceFailure = null;
		await expect(storage.restoreCurrent()).resolves.toBeNull();
		await expect(storage.read('user-a')).resolves.toBeNull();
		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(false);

		fenceFailure = 'get';
		await expect(storage.activate('user-c', 'session-c')).rejects.toThrow(
			'Fence unavailable',
		);
		fenceFailure = null;
		await expect(storage.restoreCurrent()).resolves.toBeNull();
	});

	it('clears IndexedDB when fence removal fails during sign-out', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [car('car-a', 'Buggy A')],
			},
			'session-a',
		);
		fenceFailure = 'remove';
		await expect(storage.deactivate()).resolves.toEqual(expect.any(String));
		fenceFailure = null;
		await expect(storage.restoreCurrent()).resolves.toBeNull();
		await expect(storage.read('user-a')).resolves.toBeNull();
	});

	it('fails closed when the browser blocks the localStorage object', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [car('car-a', 'Buggy A')],
			},
			'session-a',
		);
		storage.close();
		TestBed.resetTestingModule();
		TestBed.configureTestingModule({
			providers: [
				OfflineGarageStorage,
				{ provide: OFFLINE_DATABASE_NAME, useValue: databaseName },
				{ provide: OFFLINE_CURRENT_TIME, useValue: () => currentTime },
				{
					provide: OFFLINE_OPERATION_ID,
					useValue: () => `operation-${++operationNumber}`,
				},
				{ provide: OFFLINE_OWNER_FENCE_STORAGE, useValue: null },
			],
		});
		storage = TestBed.inject(OfflineGarageStorage);

		await expect(storage.restoreCurrent()).resolves.toBeNull();
		await expect(storage.activate('user-b', 'session-b')).rejects.toThrow(
			'owner-fence storage is unavailable',
		);
		await expect(storage.read('user-a')).resolves.toBeNull();
		await expect(storage.deactivate()).resolves.toEqual(expect.any(String));
	});

	it('clears version-1 snapshots that cannot be fenced by session', async () => {
		const legacy = new Dexie(databaseName);
		legacy
			.version(1)
			.stores({ snapshots: '&ownerKey,preparedAt', metadata: '&key' });
		await legacy.table('metadata').put({
			key: 'active-owner',
			ownerKey: 'legacy-user',
		});
		await legacy.table('snapshots').put({
			ownerKey: 'legacy-user',
			ownerEmail: 'legacy@example.test',
			offlineUntil: '2026-08-12T12:00:00.000Z',
			preparedAt: '2026-08-11T12:00:00.000Z',
			cars: [car('legacy-car', 'Legacy buggy')],
		});
		legacy.close();

		await expect(storage.restoreCurrent()).resolves.toBeNull();
		await expect(storage.read('legacy-user')).resolves.toBeNull();
		await expect(storage.deactivate()).resolves.toEqual(expect.any(String));
	});

	it('durably replays dependent Car changes across same-User sessions', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [],
			},
			'session-a',
		);

		const created = await storage.commitCar(
			{
				type: 'create',
				input: { name: 'Track buggy', notes: 'Fresh build' },
			},
			userAFence,
		);
		const edited = await storage.commitCar(
			{
				type: 'edit',
				carId: created.car.id,
				input: { name: 'Track buggy', notes: 'Ready to race' },
			},
			userAFence,
		);

		expect(created.operation).toMatchObject({
			operationId: 'operation-1',
			carId: 'operation-2',
			dependencies: [],
			status: 'pending',
		});
		expect(edited.operation).toMatchObject({
			operationId: 'operation-3',
			carId: 'operation-2',
			dependencies: ['operation-1'],
			status: 'pending',
		});
		expect(edited.view.cars).toContainEqual(
			expect.objectContaining({
				id: 'operation-2',
				name: 'Track buggy',
				notes: 'Ready to race',
			}),
		);
		await expect(storage.readyCarOperations()).resolves.toMatchObject([
			{ operationId: 'operation-1' },
		]);

		await expect(storage.activate('user-a', 'session-b')).resolves.toBe(true);
		await expect(storage.activate('user-a', 'session-a')).resolves.toBe(false);
		await expect(storage.carSyncView()).resolves.toMatchObject({
			cars: [{ id: 'operation-2', notes: 'Ready to race' }],
			operations: [
				{ operationId: 'operation-1' },
				{ operationId: 'operation-3' },
			],
		});
		await expect(storage.restoreCurrent()).resolves.toMatchObject({
			cars: [{ id: 'operation-2', notes: 'Ready to race' }],
		});
	});

	it('acknowledges one operation without losing a later local change', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [
					{
						id: 'car-a',
						name: 'Buggy',
						notes: 'Original',
						archivedAt: null,
						version: 4,
					},
					{ id: 'car-z', name: 'Truck', version: 1 },
				],
			},
			'session-a',
		);
		const first = await storage.commitCar(
			{
				type: 'edit',
				carId: 'car-a',
				input: { name: 'Buggy', notes: 'First edit' },
			},
			userAFence,
		);
		const second = await storage.commitCar(
			{
				type: 'edit',
				carId: 'car-a',
				input: { name: 'Renamed buggy', notes: 'First edit' },
			},
			userAFence,
		);
		expect(first.operation.sequence).toBe(1);
		expect(second.operation.sequence).toBe(2);

		const outcome: CarSyncRemoteOutcome = {
			operationId: first.operation.operationId,
			outcome: 'applied',
			car: {
				id: 'car-a',
				name: 'Buggy',
				notes: 'First edit',
				archivedAt: null,
				version: 5,
			},
		};
		const view = await storage.recordCarOutcome(outcome);

		expect(view.canonicalCars).toContainEqual(outcome.car);
		expect(view.cars).toContainEqual(
			expect.objectContaining({
				id: 'car-a',
				name: 'Renamed buggy',
				version: 5,
			}),
		);
		expect(view.operations).toMatchObject([
			{
				operationId: second.operation.operationId,
				dependencies: [],
				command: {
					baseVersion: 5,
					base: { name: 'Buggy', notes: 'First edit' },
				},
			},
		]);
		await expect(storage.readyCarOperations()).resolves.toMatchObject([
			{ operationId: second.operation.operationId },
		]);
	});

	it('does not let an older acknowledgement downgrade a newer canonical Car', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [
					{
						id: 'car-a',
						name: 'Buggy',
						notes: 'Original',
						version: 1,
					},
				],
			},
			'session-a',
		);
		const first = await storage.commitCar(
			{ type: 'edit', carId: 'car-a', input: { notes: 'First edit' } },
			userAFence,
		);
		const second = await storage.commitCar(
			{ type: 'edit', carId: 'car-a', input: { name: 'Renamed buggy' } },
			userAFence,
		);
		await storage.mergeCars(
			[
				{
					id: 'car-a',
					name: 'Remote v3',
					notes: 'First edit',
					version: 3,
				},
			],
			userAFence,
		);

		const view = await storage.recordCarOutcome({
			operationId: first.operation.operationId,
			outcome: 'applied',
			car: {
				id: 'car-a',
				name: 'Buggy',
				notes: 'First edit',
				version: 2,
			},
		});

		expect(view.canonicalCars).toEqual([
			{ id: 'car-a', name: 'Remote v3', notes: 'First edit', version: 3 },
		]);
		expect(view.cars).toEqual([
			{
				id: 'car-a',
				name: 'Renamed buggy',
				notes: 'First edit',
				version: 3,
			},
		]);
		expect(view.operations).toMatchObject([
			{
				operationId: second.operation.operationId,
				command: { baseVersion: 3, base: { name: 'Remote v3' } },
			},
		]);
	});

	it('retains server rejections and conflicts while independent work continues', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [
					{ id: 'car-a', name: 'Buggy A', archivedAt: null, version: 1 },
					{ id: 'car-b', name: 'Buggy B', archivedAt: null, version: 2 },
				],
			},
			'session-a',
		);
		const rejected = await storage.commitCar(
			{
				type: 'edit',
				carId: 'car-a',
				input: { name: '' },
			},
			userAFence,
		);
		await storage.commitCar({ type: 'archive', carId: 'car-a' }, userAFence);
		const conflicted = await storage.commitCar(
			{
				type: 'edit',
				carId: 'car-b',
				input: { name: 'Local B' },
			},
			userAFence,
		);
		await storage.recordCarOutcome({
			operationId: rejected.operation.operationId,
			outcome: 'rejected',
			error: {
				code: 'VALIDATION_ERROR',
				message: 'Name is required.',
				details: { fieldErrors: { name: ['Name is required.'] } },
			},
		});
		const view = await storage.recordCarOutcome({
			operationId: conflicted.operation.operationId,
			outcome: 'conflict',
			error: { code: 'SYNC_CONFLICT', message: 'Review both versions.' },
			remote: {
				car: { id: 'car-b', name: 'Remote B', archivedAt: null, version: 3 },
			},
		});

		expect(view.operations).toMatchObject([
			{
				operationId: rejected.operation.operationId,
				status: 'needs-attention',
				feedback: { message: 'Name is required.' },
			},
			{ dependencies: [rejected.operation.operationId], status: 'pending' },
			{
				operationId: conflicted.operation.operationId,
				status: 'conflict',
				remote: { name: 'Remote B' },
			},
		]);
		await expect(storage.readyCarOperations()).resolves.toEqual([]);
	});

	it('rebases a restore queued behind an acknowledged archive timestamp', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [{ id: 'car-a', name: 'Buggy', archivedAt: null, version: 1 }],
			},
			'session-a',
		);
		const archived = await storage.commitCar(
			{
				type: 'archive',
				carId: 'car-a',
			},
			userAFence,
		);
		const restored = await storage.commitCar(
			{
				type: 'restore',
				carId: 'car-a',
			},
			userAFence,
		);

		const view = await storage.recordCarOutcome({
			operationId: archived.operation.operationId,
			outcome: 'applied',
			car: {
				id: 'car-a',
				name: 'Buggy',
				archivedAt: '2026-08-11T12:00:05.000Z',
				version: 2,
			},
		});

		expect(view.operations).toMatchObject([
			{
				operationId: restored.operation.operationId,
				dependencies: [],
				command: {
					type: 'car.restore',
					baseVersion: 2,
					base: { archivedAt: '2026-08-11T12:00:05.000Z' },
				},
			},
		]);
	});

	it('refreshes canonical Cars while preserving pending work and clears it for another owner', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [{ id: 'car-a', name: 'Original', version: 1 }],
			},
			'session-a',
		);
		await storage.commitCar(
			{
				type: 'edit',
				carId: 'car-a',
				input: { name: 'Local' },
			},
			userAFence,
		);

		const refreshed = await storage.replaceCars([
			{ id: 'car-a', name: 'Remote', version: 2 },
			{ id: 'car-b', name: 'New remote', version: 1 },
		]);
		expect(refreshed.canonicalCars).toMatchObject([
			{ id: 'car-a', name: 'Remote' },
			{ id: 'car-b', name: 'New remote' },
		]);
		expect(refreshed.cars).toMatchObject([
			{ id: 'car-a', name: 'Local' },
			{ id: 'car-b', name: 'New remote' },
		]);

		await storage.activate('user-b', 'session-b');
		await expect(storage.read('user-a')).resolves.toBeNull();
		await expect(storage.carSyncView()).resolves.toBeNull();
	});

	it('durably merges only current server versions while preserving other Cars', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [
					{ id: 'car-a', name: 'Acknowledged', version: 3 },
					{ id: 'car-b', name: 'Preserved', version: 1 },
				],
			},
			'session-a',
		);

		const merged = await storage.mergeCars(
			[
				{ id: 'car-a', name: 'Delayed stale read', version: 2 },
				{ id: 'car-a', name: 'Unversioned stale read' },
				{ id: 'car-c', name: 'Discovered', version: 1 },
			],
			userAFence,
		);
		expect(merged.canonicalCars).toEqual([
			{ id: 'car-a', name: 'Acknowledged', version: 3 },
			{ id: 'car-b', name: 'Preserved', version: 1 },
			{ id: 'car-c', name: 'Discovered', version: 1 },
		]);
		await expect(storage.read('user-a')).resolves.toMatchObject({
			cars: merged.canonicalCars,
		});
	});

	it('rejects Car writes fenced to another owner or session', async () => {
		await storage.activate('user-b', 'session-b');
		await storage.save(
			{
				ownerKey: 'user-b',
				ownerEmail: 'b@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [{ id: 'car-b', name: 'Owner B Car', version: 1 }],
			},
			'session-b',
		);

		await expect(
			storage.commitCar(
				{ type: 'create', input: { name: 'Owner A command' } },
				userAFence,
			),
		).rejects.toThrow('offline Garage is unavailable');
		await expect(
			storage.mergeCars([{ id: 'car-a', name: 'Owner A response' }], {
				ownerKey: 'user-b',
				sessionKey: 'session-a',
			}),
		).rejects.toThrow('offline Garage is unavailable');
		await expect(storage.read('user-b')).resolves.toMatchObject({
			cars: [{ id: 'car-b', name: 'Owner B Car', version: 1 }],
		});
	});

	it('fails closed when Car sync storage has no current Garage', async () => {
		await expect(storage.readyCarOperations()).resolves.toEqual([]);
		await expect(
			storage.commitCar(
				{ type: 'create', input: { name: 'Unavailable' } },
				userAFence,
			),
		).rejects.toThrow('offline Garage is unavailable');
		await expect(
			storage.recordCarOutcome({
				operationId: 'missing',
				outcome: 'applied',
				car: { id: 'car-1', name: 'Unavailable', version: 1 },
			}),
		).rejects.toThrow('offline Garage is unavailable');
		await expect(
			storage.replaceCars([{ id: 'car-1', name: 'Unavailable' }]),
		).rejects.toThrow('offline Garage is unavailable');
		await expect(
			storage.mergeCars([{ id: 'car-1', name: 'Unavailable' }], userAFence),
		).rejects.toThrow('offline Garage is unavailable');
	});

	it('ignores an unrelated receipt and appends an acknowledged created Car', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [{ id: 'car-existing', name: 'Existing', version: 1 }],
			},
			'session-a',
		);
		const before = await storage.recordCarOutcome({
			operationId: 'another-owner-operation',
			outcome: 'applied',
			car: { id: 'ignored', name: 'Ignored', version: 1 },
		});
		expect(before.cars).toEqual([
			{ id: 'car-existing', name: 'Existing', version: 1 },
		]);

		const created = await storage.commitCar(
			{
				type: 'create',
				input: { name: 'Created' },
			},
			userAFence,
		);
		const acknowledged = await storage.recordCarOutcome({
			operationId: created.operation.operationId,
			outcome: 'applied',
			car: { id: created.car.id, name: 'Created', version: 1 },
		});
		expect(acknowledged.canonicalCars).toEqual([
			{ id: 'car-existing', name: 'Existing', version: 1 },
			{ id: created.car.id, name: 'Created', version: 1 },
		]);
	});

	it('persists and restores materialized Setup history with stable dependencies', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [{ id: 'car-a', name: 'Buggy', version: 1 }],
				setupCollections: [setupCollection()],
			},
			'session-a',
		);
		const carEdit = await storage.commitCar(
			{ type: 'edit', carId: 'car-a', input: { notes: 'Local' } },
			userAFence,
		);
		const copied = await storage.commitSetup(
			{ type: 'copy', carId: 'car-a', setupId: 'setup-1' },
			userAFence,
		);
		const selected = await storage.commitSetup(
			{
				type: 'select-current',
				carId: 'car-a',
				setupId: copied.setup.id,
			},
			userAFence,
		);

		expect(copied.operation.dependencies).toEqual([
			carEdit.operation.operationId,
		]);
		expect(selected.operation.dependencies).toEqual([
			carEdit.operation.operationId,
			copied.operation.operationId,
		]);
		await expect(storage.readySetupOperations()).resolves.toEqual([]);
		expect(
			(await storage.restoreCurrent(new Date('2026-08-11T12:00:01.000Z')))
				?.setupCollections?.[0],
		).toMatchObject({
			currentSetupId: copied.setup.id,
			setups: [{ id: copied.setup.id }, { id: 'setup-1' }],
		});

		await storage.recordCarOutcome({
			operationId: carEdit.operation.operationId,
			outcome: 'applied',
			car: { id: 'car-a', name: 'Buggy', notes: 'Local', version: 2 },
		});
		await expect(storage.readySetupOperations()).resolves.toMatchObject([
			{ operationId: copied.operation.operationId, dependencies: [] },
		]);
		const acknowledgedCopy = setup({
			id: copied.setup.id,
			name: copied.setup.name,
			current: false,
			copiedFromSetupId: 'setup-1',
			version: 1,
		});
		const afterCopy = await storage.recordSetupOutcome({
			operationId: copied.operation.operationId,
			outcome: 'applied',
			setup: acknowledgedCopy,
			currentSetupId: 'setup-1',
			currentSetupVersion: 1,
		});
		expect(afterCopy.operations).toMatchObject([
			{
				operationId: selected.operation.operationId,
				dependencies: [],
				command: {
					baseCurrent: { setupId: 'setup-1', version: 1 },
				},
			},
		]);
		await expect(storage.readySetupOperations()).resolves.toHaveLength(1);
	});

	it('initializes absent Setup history and merges new car collections', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [{ id: 'car-a', name: 'A' }],
			},
			'session-a',
		);
		await expect(storage.setupSyncView()).resolves.toMatchObject({
			canonicalCollections: [],
			collections: [],
		});
		const created = await storage.commitSetup(
			{
				type: 'create',
				carId: 'car-a',
				draft: { name: 'First local setup' },
			},
			userAFence,
		);
		expect(created.view.collections[0]?.setups).toMatchObject([
			{ name: 'First local setup' },
		]);

		const carB = setupCollection({
			carId: 'car-b',
			currentSetupId: 'setup-b',
			setups: [setup({ id: 'setup-b', carId: 'car-b' })],
		});
		await storage.mergeSetupCollection(carB, userAFence);
		const carC = setupCollection({
			carId: 'car-c',
			currentSetupId: 'setup-c',
			setups: [setup({ id: 'setup-c', carId: 'car-c' })],
		});
		await storage.mergeSetupCollection(carC, userAFence);
		const merged = await storage.mergeSetupCollection(
			{
				...carB,
				currentSetupVersion: 2,
				setups: [setup({ id: 'setup-b', carId: 'car-b', version: 2 })],
			},
			userAFence,
		);
		expect(merged.canonicalCollections.map((entry) => entry.carId)).toEqual([
			'car-b',
			'car-c',
		]);
	});

	it('ignores a Setup outcome owned by another local User', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [{ id: 'car-a', name: 'A' }],
			},
			'session-a',
		);
		const foreign: SetupSyncOperation = {
			operationId: 'foreign-operation',
			ownerKey: 'user-b',
			carId: 'car-b',
			setupId: 'setup-b',
			command: {
				type: 'setup.create',
				carId: 'car-b',
				setupId: 'setup-b',
				copiedFromSetupId: null,
				setup: { name: 'Foreign' },
				makeCurrent: false,
				baseCurrent: null,
			},
			dependencies: [],
			status: 'pending',
			createdAt: '2026-08-11T12:00:00.000Z',
			sequence: 1,
		};
		const direct = new Dexie(databaseName);
		await direct.open();
		await direct.table<SetupSyncOperation>('setupOperations').add(foreign);
		direct.close();

		const view = await storage.recordSetupOutcome({
			operationId: foreign.operationId,
			outcome: 'applied',
			setup: setup({ id: 'setup-b', carId: 'car-b' }),
			currentSetupId: null,
			currentSetupVersion: 0,
		});
		expect(view.collections).toEqual([]);
	});

	it('retains Setup rejection and conflict work without blocking another car', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [
					{ id: 'car-a', name: 'A', version: 1 },
					{ id: 'car-b', name: 'B', version: 1 },
				],
				setupCollections: [
					setupCollection(),
					setupCollection({
						carId: 'car-b',
						currentSetupId: 'setup-b',
						setups: [setup({ id: 'setup-b', carId: 'car-b' })],
					}),
				],
			},
			'session-a',
		);
		const rejected = await storage.commitSetup(
			{
				type: 'change',
				carId: 'car-a',
				setupId: 'setup-1',
				draft: { name: '' },
			},
			userAFence,
		);
		await storage.commitSetup(
			{ type: 'copy', carId: 'car-a', setupId: 'setup-1' },
			userAFence,
		);
		const conflicted = await storage.commitSetup(
			{
				type: 'correct',
				carId: 'car-b',
				setupId: 'setup-b',
				draft: { name: 'Local B' },
			},
			userAFence,
		);
		await storage.recordSetupOutcome({
			operationId: rejected.operation.operationId,
			outcome: 'rejected',
			error: { code: 'INVALID', message: 'Name is required.' },
		});
		const view = await storage.recordSetupOutcome({
			operationId: conflicted.operation.operationId,
			outcome: 'conflict',
			error: { code: 'CONFLICT', message: 'Review both versions.' },
			remote: {
				currentSetupId: 'setup-b',
				currentSetupVersion: 2,
				setup: setup({ id: 'setup-b', carId: 'car-b', name: 'Remote B' }),
			},
		});
		expect(view.operations).toMatchObject([
			{ status: 'needs-attention', feedback: { message: 'Name is required.' } },
			{ status: 'pending', dependencies: [rejected.operation.operationId] },
			{
				status: 'conflict',
				remote: { setup: { name: 'Remote B' } },
			},
		]);
		await expect(storage.readySetupOperations()).resolves.toEqual([]);
	});

	it('merges only newer Setup and Current-selection versions', async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [{ id: 'car-a', name: 'A' }],
				setupCollections: [
					setupCollection({
						currentSetupVersion: 3,
						setups: [setup({ name: 'Canonical', version: 3 })],
					}),
				],
			},
			'session-a',
		);
		const merged = await storage.mergeSetupCollection(
			setupCollection({
				currentSetupId: null,
				currentSetupVersion: 2,
				setups: [
					setup({ name: 'Stale', version: 2 }),
					setup({ id: 'setup-new', name: 'New', version: 1 }),
				],
			}),
			userAFence,
		);
		expect(merged.canonicalCollections[0]).toMatchObject({
			currentSetupId: 'setup-1',
			currentSetupVersion: 3,
			setups: [
				{ id: 'setup-1', name: 'Canonical', version: 3 },
				{ id: 'setup-new', name: 'New', version: 1 },
			],
		});
	});

	it('fails closed for unfenced or missing Setup storage and ignores unrelated outcomes', async () => {
		await expect(storage.setupSyncView()).resolves.toBeNull();
		await expect(storage.readySetupOperations()).resolves.toEqual([]);
		await expect(
			storage.commitSetup(
				{ type: 'create', carId: 'car-a', draft: { name: 'Unavailable' } },
				userAFence,
			),
		).rejects.toThrow('offline Garage is unavailable');
		await expect(
			storage.recordSetupOutcome({
				operationId: 'missing',
				outcome: 'applied',
				setup: setup(),
				currentSetupId: null,
				currentSetupVersion: 0,
			}),
		).rejects.toThrow('offline Garage is unavailable');
		await expect(
			storage.mergeSetupCollection(setupCollection(), userAFence),
		).rejects.toThrow('offline Garage is unavailable');

		await storage.activate('user-b', 'session-b');
		await storage.save(
			{
				ownerKey: 'user-b',
				ownerEmail: 'b@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [{ id: 'car-b', name: 'B' }],
				setupCollections: [],
			},
			'session-b',
		);
		await expect(
			storage.commitSetup(
				{ type: 'create', carId: 'car-a', draft: { name: 'Wrong owner' } },
				userAFence,
			),
		).rejects.toThrow('offline Garage is unavailable');
		await expect(
			storage.mergeSetupCollection(setupCollection(), {
				ownerKey: 'user-b',
				sessionKey: 'wrong-session',
			}),
		).rejects.toThrow('offline Garage is unavailable');
		const view = await storage.recordSetupOutcome({
			operationId: 'another-owner-operation',
			outcome: 'applied',
			setup: setup({ carId: 'car-b' }),
			currentSetupId: null,
			currentSetupVersion: 0,
		});
		expect(view.collections).toEqual([]);
	});
});
