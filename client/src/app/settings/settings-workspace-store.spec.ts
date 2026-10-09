import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfflineConnectivity } from '../offline/offline-connectivity';
import { OfflineGarageStorage } from '../offline/offline-garage-storage';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import type {
	SettingsOperation,
	SettingsRemoteOutcome,
	SettingsView,
} from './settings-sync.models';
import { SettingsSyncGateway } from './settings-sync-gateway';
import { settingsView } from './settings-sync-rules';
import { SettingsWorkspaceStore } from './settings-workspace-store';

const canonical = {
	timezone: 'UTC',
	invites: { allowance: 5, used: 0, remaining: 5, codes: [] },
};
const operation: SettingsOperation = {
	operationId: 'op',
	ownerKey: 'owner',
	createdAt: 'today',
	command: { type: 'timezone', base: 'UTC', timezone: 'Europe/London' },
	dependencies: [],
	status: 'pending',
};
let store: InstanceType<typeof SettingsWorkspaceStore>;
let offline: {
	ownerKey: ReturnType<typeof signal<string>>;
	sessionKey: ReturnType<typeof signal<string>>;
	hasSnapshot: ReturnType<typeof signal<boolean>>;
	networkUnavailable: ReturnType<typeof signal<boolean>>;
	markOffline: ReturnType<typeof vi.fn>;
	markOnline: ReturnType<typeof vi.fn>;
};
let view: SettingsView | null;
let storage: {
	settingsSyncView: ReturnType<typeof vi.fn>;
	commitSettings: ReturnType<typeof vi.fn>;
	recordSettingsOutcome: ReturnType<typeof vi.fn>;
};
let gateway: { apply: ReturnType<typeof vi.fn> };
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
	view = settingsView(canonical, []);
	storage = {
		settingsSyncView: vi.fn(async () => view),
		commitSettings: vi.fn(async () => {
			view = settingsView(canonical, [operation]);
			return view;
		}),
		recordSettingsOutcome: vi.fn(async () => {
			view = settingsView({ ...canonical, timezone: 'Europe/London' }, []);
			return view;
		}),
	};
	gateway = {
		apply: vi.fn(() =>
			of({ operationId: 'op', outcome: 'applied', timezone: 'Europe/London' }),
		),
	};
	connectivity = {
		retryHint: signal(0),
		scheduleRetry: vi.fn(),
		markRequestSucceeded: vi.fn(),
	};
	TestBed.configureTestingModule({
		providers: [
			{ provide: OfflineWorkspaceStore, useValue: offline },
			{ provide: OfflineGarageStorage, useValue: storage },
			{ provide: SettingsSyncGateway, useValue: gateway },
			{ provide: OfflineConnectivity, useValue: connectivity },
		],
	});
	store = TestBed.inject(SettingsWorkspaceStore);
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
	store.mutate({ requestId: 'request', change: operation.command });
	expect(store.outcome().status).toBe('pending');
	await settle();
	expect(store.outcome()).toEqual({
		status: 'succeeded',
		requestId: 'request',
	});
	expect(store.current()?.timezone).toBe('Europe/London');
	expect(store.operations()).toEqual([]);
	expect(gateway.apply).toHaveBeenCalledWith(operation);
	expect(storage.commitSettings).toHaveBeenCalledWith(operation.command, {
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
	view = settingsView(canonical, [operation]);
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
	storage.commitSettings.mockRejectedValueOnce(new Error('quota'));
	store.mutate({ requestId: 'bad', change: operation.command });
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
	storage.settingsSyncView.mockRejectedValueOnce(new Error('storage'));
	store.open();
	await settle();
	expect(store.failure()).toContain('could not be loaded');
});
it('ignores late responses after owner or session changes and prevents concurrent drain loops', async () => {
	const response = new Subject<SettingsRemoteOutcome>();
	gateway.apply.mockReturnValue(response);
	view = settingsView(canonical, [operation]);
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
		timezone: 'Europe/London',
	});
	response.complete();
	await settle();
	expect(storage.recordSettingsOutcome).not.toHaveBeenCalled();
});
it('ignores a local commit completed after ownership changes', async () => {
	offline.hasSnapshot.set(true);
	await settle();
	let complete: (value: SettingsView) => void = () => {};
	storage.commitSettings.mockReturnValueOnce(
		new Promise<SettingsView>((resolve) => {
			complete = resolve;
		}),
	);
	store.mutate({ requestId: 'late', change: operation.command });
	offline.ownerKey.set('other');
	offline.hasSnapshot.set(false);
	TestBed.tick();
	complete(settingsView(canonical, [operation]));
	await settle();
	expect(store.outcome().status).toBe('idle');
});
it.each(['open', 'synchronize'] as const)(
	'ignores a %s read resolving after the owner fence changes',
	async (action) => {
		offline.hasSnapshot.set(true);
		await settle();
		let finish: (value: SettingsView | null) => void = () => {};
		storage.settingsSyncView.mockReturnValueOnce(
			new Promise<SettingsView | null>((resolve) => {
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
		const pending = new Promise<SettingsView>((_, reject) => {
			fail = reject;
		});
		if (action === 'mutate') {
			storage.commitSettings.mockReturnValueOnce(pending);
			store.mutate({ requestId: 'late', change: operation.command });
		} else {
			storage.settingsSyncView.mockReturnValueOnce(pending);
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
	view = settingsView(canonical, [operation]);
	let complete: (value: SettingsView | null) => void = () => {};
	storage.recordSettingsOutcome.mockReturnValueOnce(
		new Promise<SettingsView | null>((resolve) => {
			complete = resolve;
		}),
	);
	store.synchronize();
	await settle();
	offline.hasSnapshot.set(false);
	TestBed.tick();
	complete(settingsView(canonical, []));
	await settle();
	expect(store.current()).toBeNull();
});

it('retains work after an unclassified transport failure without inventing connectivity evidence', async () => {
	view = settingsView(canonical, [operation]);
	gateway.apply.mockReturnValueOnce(throwError(() => null));
	offline.hasSnapshot.set(true);
	await settle();
	expect(offline.markOffline).not.toHaveBeenCalled();
	expect(store.operations()).toHaveLength(1);
});
