import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveSessionContextStore } from './drive-session-context';
import { DriveSessionGateway } from './drive-session-gateway';
import type { DriveSessionCollection } from './drive-session.models';

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
		gateway.setTimezone('invalid');
		expect(store.timezone()).toBe('UTC');
	});
});
