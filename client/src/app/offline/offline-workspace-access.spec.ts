import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineCapabilities } from './offline-capabilities';
import { OfflineGarageGateway } from './offline-garage-gateway';
import {
	type OfflineGarageSnapshot,
	OfflineGarageStorage,
} from './offline-garage-storage';
import { type OfflineOwner } from './offline-owner';
import {
	OFFLINE_NOW,
	OfflineWorkspaceAccess,
	systemClock,
	systemNow,
} from './offline-workspace-access';

const owner: OfflineOwner = {
	key: 'user-1',
	email: 'racer@example.test',
	offlineUntil: '2026-08-12T12:00:00.000Z',
};

class FakeCapabilities {
	supported = true;
	readonly prepareShell = vi.fn(async () => true);
}

class FakeGateway {
	readonly load = vi.fn(() =>
		of({ cars: [{ id: 'car-1', name: 'Track buggy' }] }),
	);
}

class FakeStorage {
	readonly activate = vi.fn(async (_ownerKey: string) => undefined);
	readonly save = vi.fn(async (_snapshot: OfflineGarageSnapshot) => undefined);
	readonly restoreCurrent = vi.fn(
		async () => null as OfflineGarageSnapshot | null,
	);
}

describe('OfflineWorkspaceAccess', () => {
	let capabilities: FakeCapabilities;
	let gateway: FakeGateway;
	let storage: FakeStorage;
	let access: OfflineWorkspaceAccess;

	beforeEach(() => {
		capabilities = new FakeCapabilities();
		gateway = new FakeGateway();
		storage = new FakeStorage();
		TestBed.configureTestingModule({
			providers: [
				OfflineWorkspaceAccess,
				{ provide: OfflineCapabilities, useValue: capabilities },
				{ provide: OfflineGarageGateway, useValue: gateway },
				{ provide: OfflineGarageStorage, useValue: storage },
				{
					provide: OFFLINE_NOW,
					useValue: () => new Date('2026-08-11T12:00:00.000Z'),
				},
			],
		});
		access = TestBed.inject(OfflineWorkspaceAccess);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('prepares and restores one durable User-scoped Garage working copy', async () => {
		await expect(access.prepare(owner)).resolves.toEqual({
			kind: 'ready',
			snapshot: {
				ownerKey: 'user-1',
				ownerEmail: 'racer@example.test',
				offlineUntil: '2026-08-12T12:00:00.000Z',
				preparedAt: '2026-08-11T12:00:00.000Z',
				cars: [{ id: 'car-1', name: 'Track buggy' }],
			},
		});
		expect(capabilities.prepareShell).toHaveBeenCalledOnce();
		expect(storage.activate).toHaveBeenCalledWith('user-1');
		expect(storage.save).toHaveBeenCalledOnce();

		const snapshot = storage.save.mock.calls[0]?.[0] ?? null;
		storage.restoreCurrent.mockResolvedValue(snapshot);
		await expect(access.restore()).resolves.toEqual(snapshot);
		expect(systemClock()).toBe(systemNow);
		expect(systemNow()).toBeInstanceOf(Date);
	});

	it('keeps unsupported environments online-only', async () => {
		capabilities.supported = false;
		await expect(access.prepare(owner)).resolves.toEqual({
			kind: 'unsupported',
		});
		await expect(access.restore()).resolves.toBeNull();
		expect(capabilities.prepareShell).not.toHaveBeenCalled();
		expect(storage.activate).not.toHaveBeenCalled();
		expect(gateway.load).not.toHaveBeenCalled();
	});
});
