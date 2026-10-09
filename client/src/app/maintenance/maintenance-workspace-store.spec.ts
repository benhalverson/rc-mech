import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CarWorkspaceStore } from '../garage/car-sync/car-workspace-store';
import { OfflineConnectivity } from '../offline/offline-connectivity';
import {
	OFFLINE_CURRENT_TIME,
	OfflineGarageStorage,
} from '../offline/offline-garage-storage';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import { tireRecord } from './consumables/consumable-sync.testing';
import type {
	MaintenanceRemoteOutcome,
	MaintenanceView,
} from './maintenance-sync.models';
import {
	maintenanceSnapshotFixture as canonical,
	maintenanceOperationFixture as operation,
} from './maintenance-sync.testing';
import { MaintenanceSyncGateway } from './maintenance-sync-gateway';
import { maintenanceView } from './maintenance-sync-rules';
import { MaintenanceWorkspaceStore } from './maintenance-workspace-store';

const command = {
	kind: 'save-plan' as const,
	mode: 'create' as const,
	id: null,
	plan: {
		carId: 'car',
		name: 'Bearings',
		intervalUnit: 'days' as const,
		intervalValue: 7,
		baselineSessionCount: 0,
	},
};
let store: InstanceType<typeof MaintenanceWorkspaceStore>;
let offline: {
	ownerKey: ReturnType<typeof signal<string>>;
	sessionKey: ReturnType<typeof signal<string>>;
	hasSnapshot: ReturnType<typeof signal<boolean>>;
	networkUnavailable: ReturnType<typeof signal<boolean>>;
	markOffline: ReturnType<typeof vi.fn>;
	markOnline: ReturnType<typeof vi.fn>;
};
let view: MaintenanceView | null;
const cars = {
	setupCollections: signal<
		import('../car/setups/setup-sync.models').SetupSyncCollection[]
	>([]),
	cars: signal([{ id: 'car', name: 'Buggy' }]),
	operations: signal([]),
	driveOperations: signal([]),
	driveCollections: signal([
		{
			carId: 'car',
			version: 1,
			sessions: [
				{
					id: 'drive',
					carId: 'car',
					startedAt: 'today',
					durationMinutes: null,
					conditions: null,
					notes: null,
					deletedAt: null,
				},
				{
					id: 'deleted',
					carId: 'car',
					startedAt: 'today',
					durationMinutes: null,
					conditions: null,
					notes: null,
					deletedAt: 'now',
				},
			],
		},
	]),
};
let storage: {
	maintenanceSyncView: ReturnType<typeof vi.fn>;
	commitMaintenance: ReturnType<typeof vi.fn>;
	recordMaintenanceOutcome: ReturnType<typeof vi.fn>;
	readyMaintenanceOperations: ReturnType<typeof vi.fn>;
	refreshMaintenance: ReturnType<typeof vi.fn>;
};
let gateway: {
	apply: ReturnType<typeof vi.fn>;
	load: ReturnType<typeof vi.fn>;
};
let connectivity: {
	retryHint: ReturnType<typeof signal<number>>;
	scheduleRetry: ReturnType<typeof vi.fn>;
	markRequestSucceeded: ReturnType<typeof vi.fn>;
};
const settle = async () => {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve();
		TestBed.tick();
	}
};
beforeEach(() => {
	offline = {
		ownerKey: signal('owner'),
		sessionKey: signal('session'),
		hasSnapshot: signal(false),
		networkUnavailable: signal(false),
		markOffline: vi.fn(),
		markOnline: vi.fn(),
	};
	view = maintenanceView(canonical, []);
	storage = {
		readyMaintenanceOperations: vi.fn(async () => view?.operations ?? []),
		refreshMaintenance: vi.fn(async () => view),
		maintenanceSyncView: vi.fn(async () => view),
		commitMaintenance: vi.fn(async () => {
			view = maintenanceView(canonical, [operation]);
			return view;
		}),
		recordMaintenanceOutcome: vi.fn(async () => {
			view = maintenanceView(canonical, []);
			return view;
		}),
	};
	gateway = {
		load: vi.fn(() => of(canonical)),
		apply: vi.fn(() =>
			of({
				operationId: 'op',
				outcome: 'applied',
				collection: canonical.collections[0],
			}),
		),
	};
	connectivity = {
		retryHint: signal(0),
		scheduleRetry: vi.fn(),
		markRequestSucceeded: vi.fn(),
	};
	TestBed.configureTestingModule({
		providers: [
			{ provide: CarWorkspaceStore, useValue: cars },
			{
				provide: OFFLINE_CURRENT_TIME,
				useValue: () => Date.parse('2026-10-09T12:00:00Z'),
			},
			{ provide: OfflineWorkspaceStore, useValue: offline },
			{ provide: OfflineGarageStorage, useValue: storage },
			{ provide: MaintenanceSyncGateway, useValue: gateway },
			{ provide: OfflineConnectivity, useValue: connectivity },
		],
	});
	store = TestBed.inject(MaintenanceWorkspaceStore);
	TestBed.tick();
});
afterEach(() => TestBed.resetTestingModule());
it('opens only the active owner, retains before success, and synchronizes stable operations', async () => {
	expect(store.current()).toBeNull();
	expect(store.operations()).toEqual([]);
	expect(store.available()).toBe(false);
	offline.hasSnapshot.set(true);
	await settle();
	expect(store.current()).toEqual(canonical);
	store.mutate({ requestId: 'request', change: command });
	expect(store.outcome().status).toBe('pending');
	await settle();
	expect(store.outcome()).toEqual({
		status: 'succeeded',
		requestId: 'request',
	});
	expect(store.current()?.timezone).toBe('UTC');
	expect(store.operations()).toEqual([]);
	expect(gateway.apply).toHaveBeenCalledWith(operation);
	expect(storage.commitMaintenance).toHaveBeenCalledWith(command, {
		ownerKey: 'owner',
		sessionKey: 'session',
	});
	offline.ownerKey.set('other');
	expect(store.current()).toBeNull();
	expect(store.operations()).toEqual([]);
	offline.hasSnapshot.set(false);
	await settle();
	expect(store.outcome().status).toBe('idle');
});
it('keeps pending work after a transport failure and retries on connectivity evidence', async () => {
	view = maintenanceView(canonical, [operation]);
	gateway.apply.mockReturnValueOnce(
		throwError(() => ({ kind: 'unavailable' })),
	);
	offline.hasSnapshot.set(true);
	await settle();
	expect(store.operations()).toHaveLength(1);
	expect(store.failure()).toContain('saved here');
	expect(connectivity.scheduleRetry).toHaveBeenCalled();
	connectivity.retryHint.update((value) => value + 1);
	await settle();
	expect(store.operations()).toEqual([]);
	expect(store.syncing()).toBe(false);
});
it('reports durable storage failure without claiming retention and handles an absent snapshot', async () => {
	offline.hasSnapshot.set(true);
	await settle();
	storage.commitMaintenance.mockRejectedValueOnce(new Error('quota'));
	store.mutate({ requestId: 'bad', change: command });
	await settle();
	expect(store.outcome()).toMatchObject({
		status: 'failed',
		message: expect.stringContaining('not been retained'),
	});
	view = null;
	store.open();
	await settle();
	expect(store.current()).toBeNull();
	expect(store.operations()).toEqual([]);
	storage.maintenanceSyncView.mockRejectedValueOnce(new Error('storage'));
	store.open();
	await settle();
	expect(store.failure()).toContain('could not be loaded');
});
it('ignores late responses after owner or session changes and prevents concurrent drain loops', async () => {
	const response = new Subject<MaintenanceRemoteOutcome>();
	gateway.apply.mockReturnValue(response);
	view = maintenanceView(canonical, [operation]);
	offline.hasSnapshot.set(true);
	await settle();
	store.synchronize();
	expect(gateway.apply).toHaveBeenCalledTimes(1);
	offline.sessionKey.set('new-session');
	expect(store.current()).toBeNull();
	expect(store.operations()).toEqual([]);
	response.next({
		operationId: 'op',
		outcome: 'applied',
		collection: canonical.collections[0],
	});
	response.complete();
	await settle();
	expect(storage.recordMaintenanceOutcome).not.toHaveBeenCalled();
});
it('ignores a local commit completed after ownership changes', async () => {
	offline.hasSnapshot.set(true);
	await settle();
	let complete: (value: MaintenanceView) => void = () => {};
	storage.commitMaintenance.mockReturnValueOnce(
		new Promise<MaintenanceView>((resolve) => {
			complete = resolve;
		}),
	);
	store.mutate({ requestId: 'late', change: command });
	offline.ownerKey.set('other');
	offline.hasSnapshot.set(false);
	TestBed.tick();
	complete(maintenanceView(canonical, [operation]));
	await settle();
	expect(store.outcome().status).toBe('idle');
});
it.each(['open', 'synchronize'] as const)(
	'ignores a %s read resolving after the owner fence changes',
	async (action) => {
		offline.hasSnapshot.set(true);
		await settle();
		let finish: (value: MaintenanceView | null) => void = () => {};
		storage.maintenanceSyncView.mockReturnValueOnce(
			new Promise<MaintenanceView | null>((resolve) => {
				finish = resolve;
			}),
		);
		store[action]();
		offline.hasSnapshot.set(false);
		TestBed.tick();
		finish(view);
		await settle();
		expect(store.current()).toBeNull();
	},
);
it.each(['open', 'synchronize', 'mutate'] as const)(
	'does not publish a late %s failure into another session',
	async (action) => {
		offline.hasSnapshot.set(true);
		await settle();
		let fail: (error: Error) => void = () => {};
		const pending = new Promise<MaintenanceView>((_, reject) => {
			fail = reject;
		});
		if (action === 'mutate') {
			storage.commitMaintenance.mockReturnValueOnce(pending);
			store.mutate({ requestId: 'late', change: command });
		} else {
			storage.maintenanceSyncView.mockReturnValueOnce(pending);
			store[action]();
		}
		offline.hasSnapshot.set(false);
		TestBed.tick();
		fail(new Error('late'));
		await settle();
		expect(store.failure()).toBe('');
		expect(store.outcome().status).toBe('idle');
	},
);
it('does not expose a database acknowledgement completed after sign-out', async () => {
	offline.hasSnapshot.set(true);
	await settle();
	view = maintenanceView(canonical, [operation]);
	let complete: (value: MaintenanceView | null) => void = () => {};
	storage.recordMaintenanceOutcome.mockReturnValueOnce(
		new Promise<MaintenanceView | null>((resolve) => {
			complete = resolve;
		}),
	);
	store.synchronize();
	await settle();
	offline.hasSnapshot.set(false);
	TestBed.tick();
	complete(maintenanceView(canonical, []));
	await settle();
	expect(store.current()).toBeNull();
});

it('retains work after an unclassified transport failure without inventing connectivity evidence', async () => {
	view = maintenanceView(canonical, [operation]);
	gateway.apply.mockReturnValueOnce(throwError(() => null));
	offline.hasSnapshot.set(true);
	await settle();
	expect(offline.markOffline).not.toHaveBeenCalled();
	expect(store.operations()).toHaveLength(1);
});
it('projects due plans, component metadata, usage and all synchronization states', async () => {
	expect(store.plans()).toEqual([]);
	expect(store.records()).toEqual([]);
	expect(store.components()).toEqual([]);
	expect(store.timezone()).toBe('UTC');
	expect(store.syncMessage()).toBe('');
	expect(store.cars()).toHaveLength(1);
	offline.hasSnapshot.set(true);
	await settle();
	expect(store.plans()[0].dueStatus).toBe('overdue');
	expect(store.records()).toHaveLength(1);
	expect(store.components()).toHaveLength(1);
	view = maintenanceView(canonical, [
		operation,
		{
			...operation,
			operationId: 'rejected',
			status: 'needs-attention',
			feedback: { code: 'NO', message: 'Archived' },
		},
		{ ...operation, operationId: 'conflict', status: 'conflict' },
		{
			...operation,
			operationId: 'rejected-no-feedback',
			status: 'needs-attention',
		},
		{
			...operation,
			operationId: 'conflict-feedback',
			status: 'conflict',
			feedback: { code: 'CONFLICT', message: 'Review remote.' },
		},
	]);
	storage.readyMaintenanceOperations.mockResolvedValueOnce([]);
	store.open();
	await settle();
	expect(store.syncMessage()).toContain('Pending sync');
	expect(store.syncMessage()).toContain('Needs attention: Archived');
	expect(store.syncMessage()).toContain('Sync conflict: Review this change.');
	view = maintenanceView(
		{
			...canonical,
			collections: [
				{
					...canonical.collections[0],
					carId: 'unknown',
					plans: [{ ...canonical.collections[0].plans[0], carId: 'unknown' }],
				},
			],
		},
		[],
	);
	store.open();
	await settle();
	expect(store.plans()[0].sessionsSinceBaseline).toBe(0);
});
it('refreshes remote snapshots while fencing late transport and persistence', async () => {
	offline.hasSnapshot.set(true);
	await settle();
	store.refresh();
	await settle();
	expect(storage.refreshMaintenance).toHaveBeenCalledWith(canonical, {
		ownerKey: 'owner',
		sessionKey: 'session',
	});
	gateway.load.mockReturnValueOnce(throwError(() => new Error('offline')));
	store.refresh();
	await settle();
	expect(store.failure()).toContain('Remote refresh is unavailable');
	const response = new Subject<typeof canonical>();
	gateway.load.mockReturnValueOnce(response);
	store.refresh();
	offline.hasSnapshot.set(false);
	TestBed.tick();
	response.next(canonical);
	await settle();
	expect(storage.refreshMaintenance).toHaveBeenCalledTimes(1);
	offline.hasSnapshot.set(true);
	await settle();
	let complete: (value: MaintenanceView | null) => void = () => {};
	storage.refreshMaintenance.mockReturnValueOnce(
		new Promise<MaintenanceView | null>((resolve) => {
			complete = resolve;
		}),
	);
	store.refresh();
	await settle();
	offline.hasSnapshot.set(false);
	TestBed.tick();
	complete(view);
	await settle();
	expect(store.current()).toBeNull();
	offline.hasSnapshot.set(true);
	await settle();
	const failure = new Subject<typeof canonical>();
	gateway.load.mockReturnValueOnce(failure);
	store.refresh();
	offline.hasSnapshot.set(false);
	TestBed.tick();
	failure.error(new Error('late'));
	await settle();
	expect(store.failure()).toBe('');
});

it('projects Consumables and selected local Setup tires without a request', async () => {
	expect(store.consumables()).toEqual([]);
	expect(store.tireSetups().size).toBe(0);
	view = maintenanceView(
		{
			...canonical,
			collections: [{ ...canonical.collections[0], consumables: [tireRecord] }],
		},
		[],
	);
	offline.hasSnapshot.set(true);
	await settle();
	expect(store.consumables()[0]).toMatchObject({
		id: 'tire',
		frontDetails: 'Front pins',
	});
	const sections = {
		vehicle: {},
		drivetrain: {},
		electronics: {},
		tires: { frontTire: 'Pins' },
		shocks: {},
		frontSuspension: {},
		rearSuspension: {},
		notes: {},
	};
	cars.setupCollections.set([
		{
			carId: 'car',
			currentSetupId: 'setup',
			currentSetupVersion: 1,
			setups: [{ id: 'setup', carId: 'car', name: 'Current', sections }],
		},
		{
			carId: 'empty',
			currentSetupId: null,
			currentSetupVersion: 0,
			setups: [],
		},
	]);
	expect(store.tireSetups().get('car')).toEqual({ frontTire: 'Pins' });
	expect(store.tireSetups().get('empty')).toBeNull();
	view = maintenanceView(canonical, []);
	store.open();
	await settle();
	expect(store.consumables()).toEqual([]);
});
