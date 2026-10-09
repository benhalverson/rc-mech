import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarWorkspaceStore } from '../../garage/car-sync/car-workspace-store';
import { OfflineWorkspaceStore } from '../../offline/offline-workspace-store';
import type { DriveSessionCollection } from './drive-session.models';
import { DriveSessionContextStore } from './drive-session-context';
import { DriveSessionGateway } from './drive-session-gateway';
import { browserTimezone } from './drive-session-time';

class FakeDriveSessionGateway {
	private readonly collectionValue = signal<DriveSessionCollection | undefined>(
		undefined,
	);
	private readonly timezoneValue = signal<
		{ timezone: string | null } | undefined
	>(undefined);
	readonly collection = {
		hasValue: () => this.collectionValue() !== undefined,
		value: () => this.collectionValue() ?? { sessions: [], timezone: null },
	};
	readonly timezone = {
		hasValue: () => this.timezoneValue() !== undefined,
		value: () => this.timezoneValue() ?? { timezone: null },
	};
	readonly selectCar = vi.fn();

	setCollection(value: DriveSessionCollection): void {
		this.collectionValue.set(value);
	}

	setTimezone(timezone: string | null): void {
		this.timezoneValue.set({ timezone });
	}
}

describe('DriveSessionContextStore', () => {
	let gateway: FakeDriveSessionGateway;
	let store: InstanceType<typeof DriveSessionContextStore>;

	beforeEach(() => {
		gateway = new FakeDriveSessionGateway();
		TestBed.configureTestingModule({
			providers: [
				{
					provide: OfflineWorkspaceStore,
					useValue: { hasSnapshot: signal(false) },
				},
				{
					provide: CarWorkspaceStore,
					useValue: { available: signal(false), driveCollections: signal([]) },
				},
				DriveSessionContextStore,
				{ provide: DriveSessionGateway, useValue: gateway },
			],
		});
		store = TestBed.inject(DriveSessionContextStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('exposes narrow drive session context without a workflow store', () => {
		expect(store.sessions()).toEqual([]);
		expect(store.timezone()).toBeTruthy();
		store.selectCar('car-1');
		store.selectCar('car-1');
		expect(gateway.selectCar).toHaveBeenCalledOnce();

		gateway.setCollection({
			sessions: [
				{
					id: 'drive-1',
					carId: 'car-1',
					startedAt: '2026-08-08T01:00:00.000Z',
					durationMinutes: null,
					conditions: null,
					notes: null,
					deletedAt: null,
				},
			],
			timezone: 'UTC',
		});
		expect(store.sessions()).toHaveLength(1);
		expect(store.timezone()).toBe('UTC');

		gateway.setCollection({ sessions: [], timezone: null });
		gateway.setTimezone('America/New_York');
		expect(store.timezone()).toBe('America/New_York');
		gateway.setCollection({ sessions: [], timezone: 'invalid' });
		expect(store.timezone()).toBe('America/New_York');
		gateway.setCollection({ sessions: [], timezone: null });
		gateway.setTimezone('invalid');
		expect(store.timezone()).toBe(browserTimezone());
	});
	it('uses pending Drive sessions from the prepared working copy', () => {
		const offline = TestBed.inject(OfflineWorkspaceStore) as unknown as {
			hasSnapshot: ReturnType<typeof signal<boolean>>;
		};
		const workspace = TestBed.inject(CarWorkspaceStore) as unknown as {
			driveCollections: ReturnType<
				typeof signal<
					readonly import('../drive-sync/drive-sync.models').DriveSyncCollection[]
				>
			>;
		};
		offline.hasSnapshot.set(true);
		expect(store.sessions()).toEqual([]);
		expect(store.timezone()).toBeTruthy();
		workspace.driveCollections.set([
			{
				carId: 'car-1',
				version: 1,
				timezone: 'America/New_York',
				sessions: [
					{
						id: 'pending',
						carId: 'car-1',
						startedAt: '2026-08-09T12:00:00Z',
						durationMinutes: null,
						conditions: null,
						notes: null,
						deletedAt: null,
					},
				],
			},
		]);
		store.selectCar('car-1');
		expect(store.sessions()[0].id).toBe('pending');
		expect(store.timezone()).toBe('America/New_York');
	});
});
