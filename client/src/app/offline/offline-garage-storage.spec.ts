/// <reference types="node" />
import { Blob as NodeBlob } from 'node:buffer';
import { TestBed } from '@angular/core/testing';
import Dexie from 'dexie';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
import type { SetupSnapshot } from '../car/setups/setup-snapshot';
import type {
	SetupSyncCollection,
	SetupSyncOperation,
} from '../car/setups/setup-sync.models';
import type { CarSyncRemoteOutcome } from '../garage/car-sync/car-sync.models';
import type { GarageCar } from '../garage/garage.models';
import {
	maintenancePlanFixture,
	maintenanceSnapshotFixture,
} from '../maintenance/maintenance-sync.testing';
import {
	voiceCaptureFixture,
	voiceUpdateFixture,
} from '../voice/voice-sync.testing';
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
	const prepareBuild = async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00Z',
				preparedAt: '2026-08-11T12:00:00Z',
				cars: [car('car-a', 'Buggy')],
			},
			'session-a',
		);
	};
	const buildCommand = {
		action: 'install',
		carId: 'car-a',
		componentId: null,
		input: { slot: 'motor', name: 'Motor' },
	} as const;

	it('restores the validated session fence for new writes after a restart', async () => {
		await prepareBuild();
		storage.close();
		storage = TestBed.runInInjectionContext(() => new OfflineGarageStorage());
		const restored = await storage.restoreCurrent();
		expect(restored?.sessionKey).toBe('session-a');
		assert(restored?.sessionKey);
		const committed = await storage.commitBuild(buildCommand, {
			ownerKey: restored.ownerKey,
			sessionKey: restored.sessionKey,
		});
		expect(committed.collection.components[0]?.name).toBe('Motor');
	});

	it('retains build history through a database restart and acknowledges dependent work in order', async () => {
		await prepareBuild();
		const first = await storage.commitBuild(buildCommand, userAFence);
		const second = await storage.commitBuild(
			{
				...buildCommand,
				action: 'edit',
				componentId: first.operation.command.componentId,
				input: { name: 'Tuned' },
			},
			userAFence,
		);
		storage.close();
		storage = TestBed.runInInjectionContext(() => new OfflineGarageStorage());
		expect(
			(await storage.restoreCurrent())?.buildCollections?.[0]?.components[0]
				?.name,
		).toBe('Tuned');
		expect(await storage.readyBuildOperations()).toEqual([first.operation]);
		await storage.recordBuildOutcome({
			operationId: first.operation.operationId,
			outcome: 'applied',
			collection: first.collection,
		});
		expect((await storage.readyBuildOperations())[0]?.operationId).toBe(
			second.operation.operationId,
		);
		await storage.recordBuildOutcome({
			operationId: second.operation.operationId,
			outcome: 'applied',
			collection: second.collection,
		});
		expect((await storage.buildSyncView())?.operations).toEqual([]);
		await storage.mergeBuildCollection(
			{ ...second.collection, version: 8 },
			userAFence,
		);
		expect(
			(await storage.buildSyncView())?.canonicalCollections[0]?.version,
		).toBe(8);
	});

	it('waits for a locally created Car while retaining independent build work', async () => {
		await prepareBuild();
		const created = await storage.commitCar(
			{ type: 'create', input: { name: 'New Car' } },
			userAFence,
		);
		const dependent = await storage.commitBuild(
			{ ...buildCommand, carId: created.car.id },
			userAFence,
		);
		const independent = await storage.commitBuild(buildCommand, userAFence);
		expect(await storage.readyBuildOperations()).toEqual([
			independent.operation,
		]);
		await storage.recordCarOutcome({
			operationId: created.operation.operationId,
			outcome: 'applied',
			car: { ...created.car, version: 1 },
		});
		expect(
			(await storage.readyBuildOperations()).map(
				(operation) => operation.operationId,
			),
		).toContain(dependent.operation.operationId);
	});

	it('retains rejection and remote conflict data without blocking independent work', async () => {
		await prepareBuild();
		const first = await storage.commitBuild(buildCommand, userAFence);
		const independent = await storage.commitBuild(
			{ ...buildCommand, input: { slot: 'esc', name: 'ESC' } },
			userAFence,
		);
		const error = { code: 'INVALID', message: 'Correct the Component name.' };
		await storage.recordBuildOutcome({
			operationId: first.operation.operationId,
			outcome: 'rejected',
			error,
		});
		expect((await storage.buildSyncView())?.operations[0]).toMatchObject({
			status: 'needs-attention',
			feedback: error,
		});
		expect(await storage.readyBuildOperations()).toEqual([
			independent.operation,
		]);
		await storage.recordBuildOutcome({
			operationId: independent.operation.operationId,
			outcome: 'conflict',
			error,
			remote: independent.collection,
		});
		expect((await storage.buildSyncView())?.operations[1]).toMatchObject({
			status: 'conflict',
			remote: independent.collection,
		});
		expect(
			(
				await storage.recordBuildOutcome({
					operationId: 'unknown',
					outcome: 'rejected',
					error,
				})
			).operations,
		).toHaveLength(2);
		await storage.deactivate('session-a');
		expect(await storage.buildSyncView()).toBeNull();
		const inspection = new Dexie(databaseName);
		await inspection.open();
		expect(await inspection.table('buildOperations').count()).toBe(0);
		inspection.close();
	});

	it('fails closed when local identity, storage, or Car availability prevents a durable build write', async () => {
		expect(await storage.buildSyncView()).toBeNull();
		expect(await storage.readyBuildOperations()).toEqual([]);
		await expect(storage.commitBuild(buildCommand, userAFence)).rejects.toThrow(
			'unavailable',
		);
		await expect(
			storage.recordBuildOutcome({
				operationId: 'unknown',
				outcome: 'rejected',
				error: { code: 'INVALID', message: 'Review' },
			}),
		).rejects.toThrow('unavailable');
		await expect(
			storage.mergeBuildCollection(
				{ carId: 'car-a', version: 1, components: [] },
				userAFence,
			),
		).rejects.toThrow('unavailable');
		await prepareBuild();
		await storage.mergeBuildCollection(
			{ carId: 'car-a', version: 0, components: [] },
			userAFence,
		);
		await expect(
			storage.commitBuild({ ...buildCommand, carId: 'missing' }, userAFence),
		).rejects.toThrow('Restore');
		await storage.commitCar({ type: 'archive', carId: 'car-a' }, userAFence);
		await expect(storage.commitBuild(buildCommand, userAFence)).rejects.toThrow(
			'Restore',
		);
		await storage.activate('user-b', 'session-b');
		expect(await storage.buildSyncView()).toBeNull();
	});
	const prepareDrive = async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00Z',
				preparedAt: '2026-08-11T12:00:00Z',
				cars: [car('car-a', 'Buggy')],
			},
			'session-a',
		);
	};
	const driveCommand = {
		action: 'save',
		carId: 'car-a',
		sessionId: null,
		input: {
			startedAt: '2026-10-09T12:00:00Z',
			durationMinutes: null,
			conditions: 'Dry',
			notes: '',
		},
	} as const;

	it('retains Drive history through a database restart and acknowledges dependent work in order', async () => {
		await prepareDrive();
		const first = await storage.commitDrive(driveCommand, userAFence);
		const second = await storage.commitDrive(
			{
				...driveCommand,
				action: 'save',
				sessionId: first.operation.command.sessionId,
				input: {
					startedAt: '2026-10-09T12:00:00Z',
					durationMinutes: 10,
					conditions: 'Tuned',
					notes: '',
				},
			},
			userAFence,
		);
		storage.close();
		storage = TestBed.runInInjectionContext(() => new OfflineGarageStorage());
		expect(
			(await storage.restoreCurrent())?.driveCollections?.[0]?.sessions[0]
				?.conditions,
		).toBe('Tuned');
		expect(await storage.readyDriveOperations()).toEqual([first.operation]);
		await storage.recordDriveOutcome({
			operationId: first.operation.operationId,
			outcome: 'applied',
			collection: first.collection,
		});
		expect((await storage.readyDriveOperations())[0]?.operationId).toBe(
			second.operation.operationId,
		);
		await storage.recordDriveOutcome({
			operationId: second.operation.operationId,
			outcome: 'applied',
			collection: second.collection,
		});
		expect((await storage.driveSyncView())?.operations).toEqual([]);
		await storage.mergeDriveCollection(
			{ ...second.collection, version: 8 },
			userAFence,
		);
		expect(
			(await storage.driveSyncView())?.canonicalCollections[0]?.version,
		).toBe(8);
	});

	it('waits for a locally created Car while retaining independent Drive work', async () => {
		await prepareDrive();
		const created = await storage.commitCar(
			{ type: 'create', input: { name: 'New Car' } },
			userAFence,
		);
		const dependent = await storage.commitDrive(
			{ ...driveCommand, carId: created.car.id },
			userAFence,
		);
		const independent = await storage.commitDrive(driveCommand, userAFence);
		expect(await storage.readyDriveOperations()).toEqual([
			independent.operation,
		]);
		await storage.recordCarOutcome({
			operationId: created.operation.operationId,
			outcome: 'applied',
			car: { ...created.car, version: 1 },
		});
		expect(
			(await storage.readyDriveOperations()).map(
				(operation) => operation.operationId,
			),
		).toContain(dependent.operation.operationId);
	});

	it('retains rejection and remote conflict data without blocking independent work', async () => {
		await prepareDrive();
		const first = await storage.commitDrive(driveCommand, userAFence);
		const independent = await storage.commitDrive(
			{
				...driveCommand,
				input: {
					startedAt: '2026-10-10T12:00:00Z',
					durationMinutes: null,
					conditions: 'Wet',
					notes: '',
				},
			},
			userAFence,
		);
		const error = { code: 'INVALID', message: 'Correct the Drive session.' };
		await storage.recordDriveOutcome({
			operationId: first.operation.operationId,
			outcome: 'rejected',
			error,
		});
		expect((await storage.driveSyncView())?.operations[0]).toMatchObject({
			status: 'needs-attention',
			feedback: error,
		});
		expect(await storage.readyDriveOperations()).toEqual([
			independent.operation,
		]);
		await storage.recordDriveOutcome({
			operationId: independent.operation.operationId,
			outcome: 'conflict',
			error,
			remote: independent.collection,
		});
		expect((await storage.driveSyncView())?.operations[1]).toMatchObject({
			status: 'conflict',
			remote: independent.collection,
		});
		expect(
			(
				await storage.recordDriveOutcome({
					operationId: 'unknown',
					outcome: 'rejected',
					error,
				})
			).operations,
		).toHaveLength(2);
		await storage.deactivate('session-a');
		expect(await storage.driveSyncView()).toBeNull();
		const inspection = new Dexie(databaseName);
		await inspection.open();
		expect(await inspection.table('driveOperations').count()).toBe(0);
		inspection.close();
	});

	it('fails closed when local identity, storage, or Car availability prevents a durable Drive write', async () => {
		expect(await storage.driveSyncView()).toBeNull();
		expect(await storage.readyDriveOperations()).toEqual([]);
		await expect(storage.commitDrive(driveCommand, userAFence)).rejects.toThrow(
			'unavailable',
		);
		await expect(
			storage.recordDriveOutcome({
				operationId: 'unknown',
				outcome: 'rejected',
				error: { code: 'INVALID', message: 'Review' },
			}),
		).rejects.toThrow('unavailable');
		await expect(
			storage.mergeDriveCollection(
				{ carId: 'car-a', version: 1, sessions: [] },
				userAFence,
			),
		).rejects.toThrow('unavailable');
		await prepareDrive();
		await storage.mergeDriveCollection(
			{ carId: 'car-a', version: 0, sessions: [] },
			userAFence,
		);
		await expect(
			storage.commitDrive({ ...driveCommand, carId: 'missing' }, userAFence),
		).rejects.toThrow('Restore');
		await storage.commitCar({ type: 'archive', carId: 'car-a' }, userAFence);
		await expect(storage.commitDrive(driveCommand, userAFence)).rejects.toThrow(
			'Restore',
		);
		await storage.activate('user-b', 'session-b');
		expect(await storage.driveSyncView()).toBeNull();
	});
	it('retains settings through restart, applies acknowledgements once, and keeps rejected intent', async () => {
		expect(await storage.isSessionRevoked('session-a')).toBe(false);
		expect(await storage.settingsSyncView()).toBeNull();
		const command = {
			type: 'timezone' as const,
			base: 'UTC',
			timezone: 'Europe/London',
		};
		await expect(storage.commitSettings(command, userAFence)).rejects.toThrow(
			'unavailable',
		);
		expect(
			await storage.recordSettingsOutcome(
				{ operationId: 'missing', outcome: 'applied', timezone: 'UTC' },
				userAFence,
			),
		).toBeNull();
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@test',
				offlineUntil: '2026-08-12T12:00:00Z',
				preparedAt: '2026-08-11T12:00:00Z',
				cars: [],
				settings: {
					timezone: 'UTC',
					invites: { allowance: 5, used: 0, remaining: 5, codes: [] },
				},
			},
			'session-a',
		);
		const committed = await storage.commitSettings(command, userAFence);
		const operationId = committed.operations[0]?.operationId as string;
		expect(committed.current.timezone).toBe('Europe/London');
		storage.close();
		storage = TestBed.runInInjectionContext(() => new OfflineGarageStorage());
		expect((await storage.settingsSyncView())?.operations).toEqual(
			committed.operations,
		);
		expect((await storage.restoreCurrent())?.sessionKey).toBe('session-a');
		const acknowledged = await storage.recordSettingsOutcome(
			{ operationId, outcome: 'applied', timezone: 'Europe/London' },
			userAFence,
		);
		expect(acknowledged?.operations).toEqual([]);
		expect(acknowledged?.current.timezone).toBe('Europe/London');
		expect(
			await storage.recordSettingsOutcome(
				{ operationId, outcome: 'applied', timezone: 'UTC' },
				userAFence,
			),
		).toEqual(acknowledged);
		const second = await storage.commitSettings(
			{ ...command, base: 'Europe/London', timezone: 'Asia/Tokyo' },
			userAFence,
		);
		const secondId = second.operations[0]?.operationId as string;
		const conflicted = await storage.recordSettingsOutcome(
			{
				operationId: secondId,
				outcome: 'conflict',
				error: 'Changed',
				remote: 'UTC',
			},
			userAFence,
		);
		expect(conflicted?.current.timezone).toBe('Asia/Tokyo');
		expect(conflicted?.operations[0]?.remote).toBe('UTC');
		const invite = await storage.commitSettings(
			{ type: 'invite-create', code: 'SETTINGS' },
			userAFence,
		);
		const inviteId = invite.operations[1]?.operationId as string;
		const rejected = await storage.recordSettingsOutcome(
			{ operationId: inviteId, outcome: 'rejected', error: 'Reserved' },
			userAFence,
		);
		expect(rejected?.operations[1]).toMatchObject({
			status: 'needs-attention',
			feedback: 'Reserved',
		});
		expect(await storage.requestSignOut('session-a', false)).toEqual({
			kind: 'confirmation',
			count: 2,
		});
		expect(await storage.settingsSyncView()).not.toBeNull();
		expect((await storage.requestSignOut('session-a', true)).kind).toBe(
			'cleared',
		);
		expect(await storage.settingsSyncView()).toBeNull();
	});
	it('clears only confirmed owner work and prevents another owner reading settings', async () => {
		expect((await storage.requestSignOut(null, false)).kind).toBe('cleared');
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@test',
				offlineUntil: '2026-08-12T12:00:00Z',
				preparedAt: '2026-08-11T12:00:00Z',
				cars: [],
				settings: {
					timezone: 'UTC',
					invites: { allowance: 5, used: 0, remaining: 5, codes: [] },
				},
			},
			'session-a',
		);
		expect((await storage.requestSignOut('session-a', false)).kind).toBe(
			'cleared',
		);
		await storage.activate('user-b', 'session-b');
		expect(await storage.settingsSyncView()).toBeNull();
		expect(await storage.read('user-a')).toBeNull();
	});
	const preparePhotos = async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00Z',
				preparedAt: '2026-08-11T12:00:00Z',
				cars: [car('car-a', 'Buggy')],
			},
			'session-a',
		);
	};
	const image = () => new File(['photo'], 'car.jpg', { type: 'image/jpeg' });
	it('retains photo bytes and metadata atomically through restart and acknowledgement', async () => {
		await preparePhotos();
		const view = await storage.commitPhoto('car-a', image(), userAFence);
		const capture = view.captures[0];
		expect(view.photos).toHaveLength(1);
		expect((await storage.readyPhotoCaptures(userAFence))[0].operationId).toBe(
			capture.operationId,
		);
		storage.close();
		storage = TestBed.runInInjectionContext(() => new OfflineGarageStorage());
		expect((await storage.restoreCurrent())?.sessionKey).toBe('session-a');
		expect(
			await storage.retainedPhoto(capture.operationId, userAFence),
		).not.toBeNull();
		await expect(
			storage.recordPhotoOutcome(
				{
					operationId: capture.operationId,
					outcome: 'applied',
					photo: capture.photo,
				},
				[],
				userAFence,
			),
		).rejects.toThrow('metadata');
		expect((await storage.photoView(userAFence)).captures).toHaveLength(1);
		const result = await storage.recordPhotoOutcome(
			{
				operationId: capture.operationId,
				outcome: 'applied',
				photo: capture.photo,
			},
			[capture.photo],
			userAFence,
		);
		expect(result.captures).toEqual([]);
		expect(result.photos).toEqual([capture.photo]);
		await storage.retainPhoto(
			capture.operationId,
			new Blob(['retained']),
			userAFence,
		);
		expect(
			await storage.retainedPhoto(capture.operationId, userAFence),
		).not.toBeNull();
		await storage.refreshPhotos(
			[capture.photo],
			capture.operationId,
			userAFence,
		);
		expect(
			await storage.retainedPhoto(capture.operationId, userAFence),
		).toBeNull();
		expect(await storage.retainedPhoto('missing', userAFence)).toBeNull();
		await expect(
			storage.retainPhoto('missing', image(), userAFence),
		).rejects.toThrow('metadata');
		await storage.refreshPhotos([], undefined, userAFence);
		expect((await storage.photoView(userAFence)).photos).toEqual([]);
	});
	it('preserves rejected photos, continues independent captures, and waits for Car changes', async () => {
		await preparePhotos();
		const first = await storage.commitPhoto('car-a', image(), userAFence);
		const capture = first.captures[0];
		await storage.recordPhotoOutcome(
			{
				operationId: capture.operationId,
				outcome: 'rejected',
				error: 'Archived',
			},
			[],
			userAFence,
		);
		expect((await storage.photoView(userAFence)).captures[0]).toMatchObject({
			status: 'needs-attention',
			feedback: 'Archived',
		});
		const second = await storage.commitPhoto('car-a', image(), userAFence);
		expect(second.photos).toHaveLength(2);
		expect(second.photos[1].isPrimary).toBe(false);
		expect(await storage.readyPhotoCaptures(userAFence)).toHaveLength(1);
		await storage.recordPhotoOutcome(
			{ operationId: 'unknown', outcome: 'rejected', error: 'No' },
			[],
			userAFence,
		);
		await storage.commitCar(
			{ type: 'edit', carId: 'car-a', input: { name: 'Renamed' } },
			userAFence,
		);
		expect(await storage.readyPhotoCaptures(userAFence)).toEqual([]);
	});
	it('rejects invalid photos and prevents writes or reads beyond the owner fence', async () => {
		const capture = {
			operationId: 'missing',
			outcome: 'rejected' as const,
			error: 'No',
		};
		await expect(storage.photoView(userAFence)).rejects.toThrow();
		await expect(
			storage.commitPhoto('car-a', image(), userAFence),
		).rejects.toThrow();
		await expect(
			storage.recordPhotoOutcome(capture, [], userAFence),
		).rejects.toThrow();
		await expect(
			storage.refreshPhotos([], undefined, userAFence),
		).rejects.toThrow();
		await preparePhotos();
		await expect(
			storage.commitPhoto('missing', image(), userAFence),
		).rejects.toThrow('active Car');
		for (const file of [
			new File(['x'], 'bad.txt', { type: 'text/plain' }),
			new File([], 'empty.jpg', { type: 'image/jpeg' }),
			new File([new Uint8Array(10485761)], 'big.jpg', { type: 'image/jpeg' }),
			new File(['x'], ' ', { type: 'image/jpeg' }),
			new File(['x'], 'x'.repeat(256), { type: 'image/jpeg' }),
		])
			await expect(
				storage.commitPhoto('car-a', file, userAFence),
			).rejects.toThrow('valid photo');
		await storage.replaceCars([
			{ ...car('car-a', 'Buggy'), archivedAt: 'today' },
		]);
		await expect(
			storage.commitPhoto('car-a', image(), userAFence),
		).rejects.toThrow('active Car');
	});
	it.each(['sign-out', 'switch', 'invalidate'] as const)(
		'removes owner photo bytes and captures on %s',
		async (action) => {
			await preparePhotos();
			await storage.commitPhoto('car-a', image(), userAFence);
			if (action === 'sign-out') await storage.deactivate();
			else if (action === 'switch')
				await storage.activate('user-b', 'session-b');
			else {
				fenceFailure = 'set';
				await expect(storage.activate('user-b', 'session-b')).rejects.toThrow();
			}
			const inspect = new Dexie(databaseName);
			await inspect.open();
			expect(await inspect.table('photoCaptures').count()).toBe(0);
			expect(await inspect.table('photoMedia').count()).toBe(0);
			inspect.close();
		},
	);
	const prepareMaintenance = async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00Z',
				preparedAt: '2026-08-11T12:00:00Z',
				cars: [car('car', 'Buggy')],
				maintenance: maintenanceSnapshotFixture,
			},
			'session-a',
		);
	};
	const maintenanceCommand = {
		kind: 'save-plan' as const,
		mode: 'create' as const,
		id: null,
		plan: {
			carId: 'car',
			name: 'New plan',
			intervalUnit: 'days' as const,
			intervalValue: 7,
			baselineSessionCount: 0,
		},
	};
	it('retains maintenance intent across restart, rebases dependencies, and avoids stale acknowledgements', async () => {
		await prepareMaintenance();
		const committed = await storage.commitMaintenance(
			maintenanceCommand,
			userAFence,
		);
		const operation = committed.operations[0];
		expect(committed.current.collections[0].plans).toHaveLength(2);
		const plan = committed.current.collections[0].plans[1];
		await storage.commitMaintenance(
			{ kind: 'transition-plan', planId: plan.id, action: 'pause' },
			userAFence,
		);
		storage.close();
		storage = TestBed.runInInjectionContext(() => new OfflineGarageStorage());
		expect(await storage.readyMaintenanceOperations(userAFence)).toHaveLength(
			1,
		);
		await storage.recordMaintenanceOutcome(
			{
				operationId: operation.operationId,
				outcome: 'applied',
				collection: { ...committed.current.collections[0], version: 3 },
			},
			userAFence,
		);
		const next = (await storage.readyMaintenanceOperations(userAFence))[0];
		expect(next.command.base).toMatchObject({ id: plan.id });
		await storage.refreshMaintenance(
			{
				...maintenanceSnapshotFixture,
				collections: [{ ...committed.current.collections[0], version: 5 }],
			},
			userAFence,
		);
		await storage.recordMaintenanceOutcome(
			{
				operationId: next.operationId,
				outcome: 'applied',
				collection: { ...committed.current.collections[0], version: 4 },
			},
			userAFence,
		);
		expect(
			(await storage.maintenanceSyncView(userAFence)).canonical.collections[0]
				.version,
		).toBe(5);
		await storage.recordMaintenanceOutcome(
			{
				operationId: 'missing',
				outcome: 'rejected',
				error: { code: 'NO', message: 'Unavailable' },
			},
			userAFence,
		);
		await storage.refreshMaintenance(
			{
				...maintenanceSnapshotFixture,
				collections: [
					{ ...committed.current.collections[0], version: 1 },
					{ carId: 'other', version: 1, plans: [], records: [] },
				],
			},
			userAFence,
		);
		expect(
			(await storage.maintenanceSyncView(userAFence)).canonical.collections[0]
				.version,
		).toBe(5);
	});
	it('waits for pending Car and Drive work while retaining service usage exactly once', async () => {
		await prepareMaintenance();
		const drive = await storage.commitDrive(
			{
				action: 'save',
				carId: 'car',
				sessionId: null,
				input: {
					startedAt: '2026-08-11T12:00:00Z',
					durationMinutes: null,
					conditions: '',
					notes: '',
				},
			},
			userAFence,
		);
		const view = await storage.commitMaintenance(
			{
				kind: 'save-service',
				mode: 'complete',
				carId: 'car',
				id: 'plan',
				service: {
					performedAt: '2026-08-11T12:00:00Z',
					description: 'Completed',
				},
			},
			userAFence,
		);
		expect(view.operations[0].sessionCount).toBe(1);
		expect(view.current.collections[0].plans[0].baselineSessionCount).toBe(1);
		expect(await storage.readyMaintenanceOperations(userAFence)).toEqual([]);
		await storage.recordDriveOutcome({
			operationId: drive.operation.operationId,
			outcome: 'applied',
			collection: drive.collection,
		});
		expect(await storage.readyMaintenanceOperations(userAFence)).toHaveLength(
			1,
		);
		await storage.commitCar(
			{ type: 'edit', carId: 'car', input: { name: 'Renamed' } },
			userAFence,
		);
		await storage.commitMaintenance(maintenanceCommand, userAFence);
		expect(await storage.readyMaintenanceOperations(userAFence)).toHaveLength(
			1,
		);
	});
	it('keeps rejection and conflicts durable without blocking independent maintenance', async () => {
		await prepareMaintenance();
		const first = await storage.commitMaintenance(
			maintenanceCommand,
			userAFence,
		);
		const operation = first.operations[0];
		await storage.recordMaintenanceOutcome(
			{
				operationId: operation.operationId,
				outcome: 'rejected',
				error: { code: 'NO', message: 'Archived' },
			},
			userAFence,
		);
		await storage.commitMaintenance(maintenanceCommand, userAFence);
		const ready = await storage.readyMaintenanceOperations(userAFence);
		expect(ready).toHaveLength(1);
		await storage.recordMaintenanceOutcome(
			{
				operationId: ready[0].operationId,
				outcome: 'conflict',
				error: { code: 'CONFLICT', message: 'Remote edit' },
				remote: {
					carId: 'car',
					version: 3,
					plans: [maintenancePlanFixture],
					records: [],
				},
			},
			userAFence,
		);
		const view = await storage.maintenanceSyncView(userAFence);
		expect(view.operations.map((operation) => operation.status)).toEqual([
			'needs-attention',
			'conflict',
		]);
		expect(view.operations[1].remote?.version).toBe(3);
	});
	it('fails closed without a valid owner, and prepares missing maintenance metadata safely', async () => {
		await expect(storage.maintenanceSyncView(userAFence)).rejects.toThrow();
		await expect(
			storage.commitMaintenance(maintenanceCommand, userAFence),
		).rejects.toThrow();
		await expect(
			storage.refreshMaintenance(maintenanceSnapshotFixture, userAFence),
		).rejects.toThrow();
		await expect(
			storage.recordMaintenanceOutcome(
				{
					operationId: 'missing',
					outcome: 'rejected',
					error: { code: 'NO', message: 'No' },
				},
				userAFence,
			),
		).rejects.toThrow();
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'a@example.test',
				offlineUntil: '2026-08-12T12:00:00Z',
				preparedAt: '2026-08-11T12:00:00Z',
				cars: [],
			},
			'session-a',
		);
		expect(
			(await storage.maintenanceSyncView(userAFence)).current.collections,
		).toEqual([]);
		await expect(
			storage.commitMaintenance(maintenanceCommand, userAFence),
		).rejects.toThrow('active Car');
		await storage.refreshMaintenance(maintenanceSnapshotFixture, userAFence);
		await storage.replaceCars([
			{ ...car('car', 'Buggy'), archivedAt: 'today' },
		]);
		await expect(
			storage.commitMaintenance(maintenanceCommand, userAFence),
		).rejects.toThrow('active Car');
	});
	it.each(['sign-out', 'switch', 'invalidate'] as const)(
		'clears maintenance commands on %s',
		async (action) => {
			await prepareMaintenance();
			await storage.commitMaintenance(maintenanceCommand, userAFence);
			if (action === 'sign-out') await storage.deactivate();
			else if (action === 'switch')
				await storage.activate('user-b', 'session-b');
			else {
				fenceFailure = 'set';
				await expect(storage.activate('user-b', 'session-b')).rejects.toThrow();
			}
			const inspect = new Dexie(databaseName);
			await inspect.open();
			expect(await inspect.table('maintenanceOperations').count()).toBe(0);
			inspect.close();
		},
	);
	const prepareVoice = async () => {
		await storage.activate('user-a', 'session-a');
		await storage.save(
			{
				ownerKey: 'user-a',
				ownerEmail: 'owner@example.com',
				offlineUntil: '2026-08-12T00:00:00Z',
				preparedAt: '2026-08-11T12:00:00Z',
				cars: [car('car', 'Voice buggy')],
			},
			'session-a',
		);
	};
	it('retains exact voice bytes and stable identity across restart, processing and metadata refresh', async () => {
		await prepareVoice();
		// Native Blob is structured-cloneable in fake-indexeddb; jsdom's wrapper is not.
		const blob = new NodeBlob([new Uint8Array([1, 2, 3, 255])], {
			type: 'audio/webm',
		}) as unknown as Blob;
		const capture = { ...voiceCaptureFixture, blob };
		await storage.keepVoice(capture, userAFence);
		await storage.keepVoice(
			{ ...capture, text: 'duplicate must not overwrite' },
			userAFence,
		);
		storage.close();
		storage = TestBed.runInInjectionContext(() => new OfflineGarageStorage());
		let view = await storage.voiceView(userAFence);
		expect(view.captures).toHaveLength(1);
		expect(view.captures[0].text).toBe(voiceCaptureFixture.text);
		expect(await view.captures[0].blob?.arrayBuffer()).toEqual(
			await blob.arrayBuffer(),
		);
		expect(await storage.readyVoice(userAFence)).toHaveLength(1);
		view = await storage.changeVoice(
			capture.id,
			{ phase: 'processing', remote: voiceUpdateFixture },
			userAFence,
		);
		expect(view.updates).toEqual([voiceUpdateFixture]);
		await storage.changeVoice(
			capture.id,
			{
				phase: 'retained',
				remote: { ...voiceUpdateFixture, status: 'needs-review' },
			},
			userAFence,
		);
		expect(await storage.readyVoice(userAFence)).toEqual([]);
		view = await storage.refreshVoice(
			[
				{
					...voiceUpdateFixture,
					status: 'saved',
					updatedAt: '2026-10-10T12:00:00Z',
				},
			],
			userAFence,
		);
		expect(view.updates[0].status).toBe('saved');
		expect(await view.captures[0].blob?.arrayBuffer()).toEqual(
			await blob.arrayBuffer(),
		);
		await storage.refreshVoice([voiceUpdateFixture], userAFence);
		expect((await storage.voiceView(userAFence)).updates[0].status).toBe(
			'saved',
		);
		await storage.refreshVoice(
			[
				{
					...voiceUpdateFixture,
					id: 'unretained',
					artifactDeletedAt: '2026-10-11T12:00:00Z',
				},
				{
					...voiceUpdateFixture,
					status: 'saved',
					updatedAt: '2026-10-11T12:00:00Z',
					artifactDeletedAt: '2026-10-11T12:00:00Z',
				},
			],
			userAFence,
		);
		expect(
			(await storage.voiceView(userAFence)).captures[0].blob,
		).toBeUndefined();
		await storage.changeVoice('missing', 'discard', userAFence);
		await storage.changeVoice(capture.id, 'discard', userAFence);
		expect((await storage.voiceView(userAFence)).captures).toEqual([]);
	});
	it('imports legacy captures once and never overwrites progress or another owner', async () => {
		await prepareVoice();
		const legacy = {
			...voiceCaptureFixture,
			ownerKey: 'owner@example.com',
			blob: new Blob(['original']),
		};
		await storage.importVoice(
			[legacy, { ...legacy, id: 'failed', status: 'failed' }],
			userAFence,
		);
		await storage.changeVoice(legacy.id, { phase: 'processing' }, userAFence);
		await storage.importVoice([legacy], userAFence);
		const view = await storage.voiceView(userAFence);
		expect(view.captures).toHaveLength(2);
		expect(view.captures.find((c) => c.id === legacy.id)?.phase).toBe(
			'processing',
		);
		expect(await storage.readyVoice(userAFence)).toHaveLength(1);
		await expect(
			storage.importVoice(
				[{ ...legacy, ownerKey: 'someone-else' }],
				userAFence,
			),
		).rejects.toThrow('another User');
		const database = new Dexie(databaseName);
		await database.open();
		await database.table('voiceCaptures').put({
			...legacy,
			id: 'collision',
			ownerKey: 'someone-else',
			phase: 'upload',
			dependencies: [],
		});
		database.close();
		await expect(
			storage.importVoice([{ ...legacy, id: 'collision' }], userAFence),
		).rejects.toThrow('identity');
		await expect(
			storage.keepVoice({ ...legacy, id: 'collision' }, userAFence),
		).rejects.toThrow('identity');
	});
	it('waits for locally-created Car and Drive dependencies before voice upload', async () => {
		await prepareVoice();
		const created = await storage.commitCar(
			{ type: 'create', input: { name: 'Local Car' } },
			userAFence,
		);
		const drive = await storage.commitDrive(
			{
				action: 'save',
				carId: created.car.id,
				sessionId: null,
				input: {
					startedAt: '2026-08-11T12:00:00Z',
					durationMinutes: null,
					conditions: 'Dry',
					notes: '',
				},
			},
			userAFence,
		);
		const capture = {
			...voiceCaptureFixture,
			carId: created.car.id,
			driveSessionId: drive.collection.sessions[0].id,
		};
		await storage.keepVoice(capture, userAFence);
		expect(await storage.readyVoice(userAFence)).toEqual([]);
		await storage.recordCarOutcome({
			operationId: created.operation.operationId,
			outcome: 'applied',
			car: { ...created.car, version: 1 },
		});
		expect(await storage.readyVoice(userAFence)).toEqual([]);
		await storage.recordDriveOutcome({
			operationId: drive.operation.operationId,
			outcome: 'applied',
			collection: { ...drive.collection, version: 2 },
		});
		expect(await storage.readyVoice(userAFence)).toHaveLength(1);
		await expect(
			storage.keepVoice(
				{ ...capture, id: 'invalid-drive', driveSessionId: 'missing' },
				userAFence,
			),
		).rejects.toThrow('matching Drive');
		await expect(
			storage.keepVoice(
				{ ...capture, id: 'invalid-car', carId: 'missing' },
				userAFence,
			),
		).rejects.toThrow('active Car');
	});
	it('fences every voice storage operation and includes original bytes in owner cleanup', async () => {
		for (const call of [
			() => storage.voiceView(userAFence),
			() => storage.keepVoice(voiceCaptureFixture, userAFence),
			() => storage.importVoice([], userAFence),
			() => storage.changeVoice('capture', 'discard', userAFence),
			() => storage.refreshVoice([], userAFence),
		])
			await expect(call()).rejects.toThrow('unavailable');
		await prepareVoice();
		await storage.keepVoice(voiceCaptureFixture, userAFence);
		await storage.deactivate('signout');
		const database = new Dexie(databaseName);
		await database.open();
		expect(await database.table('voiceCaptures').count()).toBe(0);
		database.close();
	});
});
