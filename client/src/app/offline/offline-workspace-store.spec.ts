import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('OfflineWorkspaceStore', () => {
	let access: FakeAccess;
	let store: InstanceType<typeof OfflineWorkspaceStore>;

	beforeEach(() => {
		access = new FakeAccess();
		TestBed.configureTestingModule({
			providers: [
				OfflineWorkspaceStore,
				{ provide: OfflineWorkspaceAccess, useValue: access },
			],
		});
		store = TestBed.inject(OfflineWorkspaceStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('publishes Preparing, Offline ready, and restored Offline state', async () => {
		expect(store.status()).toBe('idle');
		expect(store.message()).toBe('');
		expect(store.hasSnapshot()).toBe(false);

		store.openOffline({ snapshot });
		expect(store.status()).toBe('offline');
		expect(store.message()).toBe('Offline—changes will sync later');
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
		expect(store.cars()).toEqual(snapshot.cars);
		expect(store.hasSnapshot()).toBe(true);
	});

	it('explains unsupported capability and preparation failures honestly', async () => {
		access.prepare.mockResolvedValueOnce({ kind: 'unsupported' });
		store.prepare({
			owner: {
				key: 'user-1',
				email: 'racer@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
			},
		});
		await vi.waitFor(() => expect(store.status()).toBe('online-only'));
		expect(store.message()).toContain(
			'Offline access is unavailable in this browser',
		);

		access.prepare.mockRejectedValueOnce(new Error('IndexedDB failed'));
		store.prepare({
			owner: {
				key: 'user-1',
				email: 'racer@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
			},
		});
		await vi.waitFor(() =>
			expect(store.message()).toContain('could not be prepared'),
		);
		expect(store.cars()).toEqual([]);
	});
});
