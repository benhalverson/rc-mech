import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineConnectivity } from './offline-connectivity';
import type { OfflinePreparationResult } from './offline-workspace-access';
import { OfflineWorkspaceAccess } from './offline-workspace-access';
import { OfflineWorkspaceStore } from './offline-workspace-store';

const snapshot = {
	ownerKey: 'user-1',
	ownerEmail: 'racer@example.test',
	offlineUntil: '2026-08-12T12:00:00.000Z',
	preparedAt: '2026-08-11T12:00:00.000Z',
	cars: [{ id: 'car-1', name: 'Track buggy' }],
} as const;

class FakeAccess {
	readonly prepare = vi.fn(
		async (): Promise<OfflinePreparationResult> => ({
			kind: 'ready',
			snapshot,
		}),
	);
}

class FakeConnectivity {
	readonly online = signal(true);
}

describe('OfflineWorkspaceStore', () => {
	let access: FakeAccess;
	let connectivity: FakeConnectivity;
	let store: InstanceType<typeof OfflineWorkspaceStore>;

	beforeEach(() => {
		access = new FakeAccess();
		connectivity = new FakeConnectivity();
		TestBed.configureTestingModule({
			providers: [
				OfflineWorkspaceStore,
				{ provide: OfflineWorkspaceAccess, useValue: access },
				{ provide: OfflineConnectivity, useValue: connectivity },
			],
		});
		store = TestBed.inject(OfflineWorkspaceStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('publishes Preparing, Offline ready, and restored Offline state', async () => {
		expect(store.status()).toBe('idle');
		expect(store.message()).toBe('');
		expect(store.hasSnapshot()).toBe(false);
		expect(store.networkUnavailable()).toBe(false);

		store.openOffline({ snapshot });
		expect(store.status()).toBe('offline');
		expect(store.networkUnavailable()).toBe(true);
		expect(store.message()).toBe('Offline—prepared Garage is read-only');
		expect(store.cars()).toEqual(snapshot.cars);
		expect(store.hasSnapshot()).toBe(true);
		expect(store.ownerEmail()).toBe('racer@example.test');

		let finishPreparation!: (result: OfflinePreparationResult) => void;
		access.prepare.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishPreparation = resolve;
				}),
		);
		store.prepare({
			owner: {
				key: 'user-2',
				email: 'second@example.test',
				sessionKey: 'session-2',
				offlineUntil: '2026-08-12T12:00:00.000Z',
			},
		});
		expect(store.status()).toBe('preparing');
		expect(store.message()).toBe('Preparing offline access…');
		expect(store.cars()).toEqual([]);
		expect(store.hasSnapshot()).toBe(false);
		expect(store.ownerEmail()).toBe('second@example.test');

		finishPreparation({ kind: 'ready', snapshot });
		await vi.waitFor(() => expect(store.status()).toBe('ready'));
		expect(store.message()).toBe('Offline ready');
		expect(store.networkUnavailable()).toBe(false);
		expect(store.cars()).toEqual(snapshot.cars);
		expect(store.hasSnapshot()).toBe(true);
	});

	it('moves a prepared workspace offline after a failed live request', async () => {
		store.markOffline();
		expect(store.status()).toBe('idle');

		store.prepare({
			owner: {
				key: 'user-1',
				email: 'racer@example.test',
				sessionKey: 'session-1',
				offlineUntil: '2026-08-12T12:00:00.000Z',
			},
		});
		await vi.waitFor(() => expect(store.status()).toBe('ready'));

		connectivity.online.set(false);
		await vi.waitFor(() => expect(store.status()).toBe('offline'));
		expect(store.status()).toBe('offline');
		expect(store.message()).toBe('Offline—prepared Garage is read-only');

		store.markOffline();
		expect(store.status()).toBe('offline');

		connectivity.online.set(true);
		await vi.waitFor(() => expect(store.status()).toBe('ready'));
		expect(store.message()).toBe('Offline ready');
		store.markOnline();
		expect(store.status()).toBe('ready');
	});

	it('keeps only the newest overlapping User preparation', async () => {
		let finishFirst!: (result: OfflinePreparationResult) => void;
		let finishSecond!: (result: OfflinePreparationResult) => void;
		access.prepare
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishFirst = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishSecond = resolve;
					}),
			);
		store.prepare({
			owner: {
				key: 'user-1',
				email: 'first@example.test',
				sessionKey: 'session-1',
				offlineUntil: '2026-08-12T12:00:00.000Z',
			},
		});
		store.prepare({
			owner: {
				key: 'user-2',
				email: 'second@example.test',
				sessionKey: 'session-2',
				offlineUntil: '2026-08-12T12:00:00.000Z',
			},
		});

		finishFirst({ kind: 'ready', snapshot });
		await Promise.resolve();
		expect(store.status()).toBe('preparing');
		expect(store.ownerEmail()).toBe('second@example.test');

		finishSecond({
			kind: 'ready',
			snapshot: {
				...snapshot,
				ownerKey: 'user-2',
				ownerEmail: 'second@example.test',
			},
		});
		await vi.waitFor(() => expect(store.status()).toBe('ready'));
		expect(store.ownerEmail()).toBe('second@example.test');
	});

	it('explains unsupported capability and preparation failures honestly', async () => {
		access.prepare.mockResolvedValueOnce({ kind: 'unsupported' });
		store.prepare({
			owner: {
				key: 'user-1',
				email: 'racer@example.test',
				sessionKey: 'session-1',
				offlineUntil: '2026-08-12T12:00:00.000Z',
			},
		});
		await vi.waitFor(() => expect(store.status()).toBe('online-only'));
		expect(store.message()).toContain(
			'Offline access is unavailable in this browser',
		);
		connectivity.online.set(false);
		await vi.waitFor(() => expect(store.status()).toBe('offline-unavailable'));
		expect(store.networkUnavailable()).toBe(true);
		expect(store.hasSnapshot()).toBe(false);
		expect(store.message()).toBe(
			'Offline—this browser has no prepared Garage.',
		);

		access.prepare.mockResolvedValueOnce({ kind: 'unsupported' });
		store.prepare({
			owner: {
				key: 'user-1',
				email: 'racer@example.test',
				sessionKey: 'session-1',
				offlineUntil: '2026-08-12T12:00:00.000Z',
			},
		});
		await vi.waitFor(() => expect(store.status()).toBe('offline-unavailable'));

		connectivity.online.set(true);
		await vi.waitFor(() => expect(store.status()).toBe('online-only'));
		expect(store.networkUnavailable()).toBe(false);

		access.prepare.mockRejectedValueOnce(new Error('IndexedDB failed'));
		store.prepare({
			owner: {
				key: 'user-1',
				email: 'racer@example.test',
				sessionKey: 'session-1',
				offlineUntil: '2026-08-12T12:00:00.000Z',
			},
		});
		await vi.waitFor(() =>
			expect(store.message()).toContain('could not be prepared'),
		);
		expect(store.cars()).toEqual([]);
	});

	it('preserves a confirmed outage while preparation fails', async () => {
		let rejectPreparation!: (error: Error) => void;
		access.prepare.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectPreparation = reject;
				}),
		);
		store.prepare({
			owner: {
				key: 'user-1',
				email: 'racer@example.test',
				sessionKey: 'session-1',
				offlineUntil: '2026-08-12T12:00:00.000Z',
			},
		});
		store.markOffline();
		expect(store.status()).toBe('preparing');
		expect(store.networkUnavailable()).toBe(true);

		rejectPreparation(new Error('network unavailable'));
		await vi.waitFor(() => expect(store.status()).toBe('offline-unavailable'));
		expect(store.networkUnavailable()).toBe(true);
		expect(store.hasSnapshot()).toBe(false);
	});
});
