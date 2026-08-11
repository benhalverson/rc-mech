import { TestBed } from '@angular/core/testing';
import Dexie from 'dexie';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GarageCar } from '../garage/garage.models';
import {
	OFFLINE_DATABASE_NAME,
	OfflineGarageStorage,
	offlineDatabaseName,
} from './offline-garage-storage';

const car = (id: string, name: string): GarageCar => ({ id, name });

describe('OfflineGarageStorage', () => {
	let storage: OfflineGarageStorage;
	let databaseName: string;

	beforeEach(() => {
		Dexie.dependencies.indexedDB = indexedDB;
		Dexie.dependencies.IDBKeyRange = IDBKeyRange;
		databaseName = `offline-garage-${crypto.randomUUID()}`;
		TestBed.configureTestingModule({
			providers: [
				OfflineGarageStorage,
				{ provide: OFFLINE_DATABASE_NAME, useValue: databaseName },
			],
		});
		storage = TestBed.inject(OfflineGarageStorage);
	});

	afterEach(async () => {
		storage.close();
		await Dexie.delete(databaseName);
		TestBed.resetTestingModule();
	});

	it('keeps User-scoped Garage snapshots and restores only the latest User', async () => {
		expect(offlineDatabaseName()).toBe('chassis-notes-offline-v1');
		expect(
			await storage.restoreCurrent(new Date('2026-08-11T12:00:00.000Z')),
		).toBeNull();

		await storage.save({
			ownerKey: 'user-a',
			ownerEmail: 'a@example.test',
			offlineUntil: '2026-08-12T12:00:00.000Z',
			preparedAt: '2026-08-11T12:00:00.000Z',
			cars: [car('car-a', 'Buggy A')],
		});
		await storage.save({
			ownerKey: 'user-b',
			ownerEmail: 'b@example.test',
			offlineUntil: '2026-08-12T12:00:00.000Z',
			preparedAt: '2026-08-11T12:01:00.000Z',
			cars: [car('car-b', 'Buggy B')],
		});

		expect(await storage.read('user-a')).toMatchObject({
			ownerEmail: 'a@example.test',
			cars: [{ id: 'car-a', name: 'Buggy A' }],
		});
		expect(
			await storage.restoreCurrent(new Date('2026-08-11T12:02:00.000Z')),
		).toMatchObject({
			ownerKey: 'user-b',
			cars: [{ id: 'car-b', name: 'Buggy B' }],
		});

		await storage.activate('user-without-a-snapshot');
		expect(
			await storage.restoreCurrent(new Date('2026-08-11T12:02:00.000Z')),
		).toBeNull();
		expect(await storage.read('user-a')).toMatchObject({
			cars: [{ id: 'car-a' }],
		});
	});

	it('refuses to restore a Garage after the server session expiry', async () => {
		await storage.save({
			ownerKey: 'user-a',
			ownerEmail: 'a@example.test',
			offlineUntil: '2026-08-11T12:00:00.000Z',
			preparedAt: '2026-08-11T11:00:00.000Z',
			cars: [car('car-a', 'Buggy A')],
		});

		expect(
			await storage.restoreCurrent(new Date('2026-08-11T12:00:00.000Z')),
		).toBeNull();
		expect(await storage.read('missing-user')).toBeNull();
	});
});
