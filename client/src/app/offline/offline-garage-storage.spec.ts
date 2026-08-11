import { TestBed } from '@angular/core/testing';
import Dexie from 'dexie';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
