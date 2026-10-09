import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { type Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineCapabilities } from '../offline/offline-capabilities';
import { OfflineConnectivity } from '../offline/offline-connectivity';
import { OfflineGarageStorage } from '../offline/offline-garage-storage';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import { OwnerSessionStore } from '../owner-session-store';
import { VoiceLegacyMigration } from '../voice/voice-legacy-migration';
import { type SignOutGatewayFailure } from './sign-out-contract';
import { SignOutGateway } from './sign-out-gateway';
import type { SignOutResponse } from './sign-out-response';
import { type SignOutCommand, SignOutStore } from './sign-out-store';

class FakeSignOutGateway {
	readonly resumeSignOut = vi.fn((_key: string) => this.signOut());
	private mutation = new Subject<SignOutResponse>();
	readonly signOut = vi.fn(
		(): Observable<SignOutResponse> => this.mutation.asObservable(),
	);

	succeed(): void {
		this.mutation.next({ success: true });
		this.mutation.complete();
	}

	fail(error: SignOutGatewayFailure): void {
		this.mutation.error(error);
	}

	reset(): void {
		this.mutation = new Subject<SignOutResponse>();
	}
}

describe('SignOutStore', () => {
	let gateway: FakeSignOutGateway;
	let navigate: ReturnType<typeof vi.fn>;
	let expire: ReturnType<typeof vi.fn>;
	let deactivate: ReturnType<typeof vi.fn>;
	let completeSignOut: ReturnType<typeof vi.fn>;
	let sessionKey: ReturnType<typeof vi.fn>;
	let capabilities: { storageAvailable: boolean };
	let store: InstanceType<typeof SignOutStore>;

	beforeEach(() => {
		gateway = new FakeSignOutGateway();
		navigate = vi.fn(() => Promise.resolve(true));
		expire = vi.fn();
		deactivate = vi.fn(() =>
			Promise.resolve({ kind: 'cleared', operationId: 'sign-out-1' }),
		);
		completeSignOut = vi.fn(() => Promise.resolve());
		sessionKey = vi.fn(() => 'session-1');
		capabilities = { storageAvailable: true };
		TestBed.configureTestingModule({
			providers: [
				{
					provide: VoiceLegacyMigration,
					useValue: {
						pendingForSignOut: vi.fn(async () => []),
						discardForSignOut: vi.fn(async () => {}),
					},
				},
				{
					provide: OfflineConnectivity,
					useValue: { retryHint: signal(0), scheduleRetry: vi.fn() },
				},
				{
					provide: OfflineWorkspaceStore,
					useValue: {
						ownerEmail: signal('owner@example.test'),
						networkUnavailable: signal(false),
						clear: vi.fn(),
					},
				},
				SignOutStore,
				{ provide: OfflineCapabilities, useValue: capabilities },
				{ provide: SignOutGateway, useValue: gateway },
				{
					provide: OfflineGarageStorage,
					useValue: {
						completeSignOut,
						pendingWorkCount: vi.fn(async () => 2),
						requestSignOut: deactivate,
						pendingSignOut: vi.fn(async () => null),
					},
				},
				{ provide: Router, useValue: { navigate } },
				{
					provide: OwnerSessionStore,
					useValue: {
						ownerEmail: () => 'owner@example.test',
						expire,
						sessionKey,
						signOutLocally: vi.fn(),
					},
				},
			],
		});
		store = TestBed.inject(SignOutStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('restores deferred sign-out after restart and retries storage failures', async () => {
		const storage = TestBed.inject(OfflineGarageStorage);
		vi.mocked(storage.pendingSignOut).mockResolvedValueOnce({
			operationId: 'restored',
			sessionKey: 'old-session',
		});
		await store.restorePendingSignOut();
		expect(gateway.resumeSignOut).toHaveBeenCalledWith('old-session');
		expect(store.pendingRemoteOperationId()).toBe('restored');
		gateway.succeed();
		await vi.waitFor(() => expect(store.pendingRemoteOperationId()).toBeNull());
		vi.mocked(storage.pendingSignOut).mockRejectedValueOnce(
			new Error('storage'),
		);
		await store.restorePendingSignOut();
		expect(
			TestBed.inject(OfflineConnectivity).scheduleRetry,
		).toHaveBeenCalled();
	});

	it('confirms unmigrated legacy Voice work before clearing either queue and keeps it when cleanup fails', async () => {
		const legacy = TestBed.inject(VoiceLegacyMigration);
		(
			TestBed.inject(OfflineWorkspaceStore).ownerEmail as ReturnType<
				typeof signal<string>
			>
		).set('');
		vi.mocked(legacy.pendingForSignOut).mockResolvedValue(['legacy']);
		store.signOut({ operation: 'sign-out' });
		await vi.waitFor(() =>
			expect(store.outcome()).toMatchObject({
				status: 'confirmation',
				count: 3,
			}),
		);
		expect(deactivate).not.toHaveBeenCalled();
		expect(legacy.discardForSignOut).not.toHaveBeenCalled();
		vi.mocked(legacy.discardForSignOut).mockRejectedValueOnce(
			new Error('storage'),
		);
		store.signOut({ operation: 'sign-out', discardPending: true });
		await vi.waitFor(() => expect(store.outcome().status).toBe('failed'));
		expect(deactivate).not.toHaveBeenCalled();
		store.signOut({ operation: 'sign-out', discardPending: true });
		await vi.waitFor(() => expect(gateway.signOut).toHaveBeenCalled());
		expect(legacy.discardForSignOut).toHaveBeenCalledWith('owner@example.test');
		gateway.succeed();
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
	});

	it('starts idle with no loading or failure presentation', () => {
		expect(store.outcome()).toEqual({
			status: 'idle',
			operation: 'sign-out',
			operationId: null,
		});
		expect(store.signingOut()).toBe(false);
		expect(store.error()).toBe('');
	});

	it('suppresses duplicate commands and publishes successful outcomes', async () => {
		const command: SignOutCommand = { operation: 'sign-out' };
		expect(store.signOut(command)).toBeUndefined();
		expect(store.outcome()).toEqual({
			status: 'pending',
			operation: 'sign-out',
			operationId: 1,
		});
		expect(store.signingOut()).toBe(true);

		store.signOut(command);
		await vi.waitFor(() => expect(gateway.signOut).toHaveBeenCalledOnce());
		gateway.succeed();
		await vi.waitFor(() =>
			expect(store.outcome()).toEqual({
				status: 'succeeded',
				operation: 'sign-out',
				operationId: 1,
			}),
		);
		expect(expire).toHaveBeenCalledOnce();
		expect(navigate).toHaveBeenCalledWith(['/sign-in']);
		expect(deactivate).toHaveBeenCalledWith('session-1', false);
		expect(completeSignOut).toHaveBeenCalledOnce();
		expect(completeSignOut).toHaveBeenCalledWith('sign-out-1');
		expect(store.error()).toBe('');

		gateway.reset();
		store.signOut(command);
		await vi.waitFor(() => expect(gateway.signOut).toHaveBeenCalledTimes(2));
		gateway.fail({ kind: 'http', status: 403 });
		await vi.waitFor(() =>
			expect(store.outcome()).toEqual({
				status: 'failed',
				operation: 'sign-out',
				operationId: 2,
				error: { kind: 'http', status: 403 },
			}),
		);
		expect(completeSignOut).toHaveBeenCalledOnce();
		expect(store.error()).toContain('could not sign you out');
	});

	it('preserves successful sign-out when navigation cannot complete', async () => {
		navigate.mockRejectedValueOnce(new Error('navigation failed'));
		store.signOut({ operation: 'sign-out' });
		await vi.waitFor(() => expect(gateway.signOut).toHaveBeenCalledOnce());
		gateway.succeed();
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(expire).toHaveBeenCalledOnce();
	});

	it('does not end the server session when offline cleanup fails', async () => {
		deactivate.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
		store.signOut({ operation: 'sign-out' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('failed'));
		expect(store.outcome()).toMatchObject({
			error: { kind: 'unavailable' },
		});
		expect(gateway.signOut).not.toHaveBeenCalled();
		expect(expire).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});

	it('signs out online-only browsers without opening IndexedDB', async () => {
		TestBed.resetTestingModule();
		capabilities.storageAvailable = false;
		TestBed.configureTestingModule({
			providers: [
				{
					provide: OfflineConnectivity,
					useValue: { retryHint: signal(0), scheduleRetry: vi.fn() },
				},
				{
					provide: OfflineWorkspaceStore,
					useValue: {
						ownerEmail: signal('owner@example.test'),
						networkUnavailable: signal(false),
						clear: vi.fn(),
					},
				},
				SignOutStore,
				{ provide: OfflineCapabilities, useValue: capabilities },
				{ provide: SignOutGateway, useValue: gateway },
				{
					provide: OfflineGarageStorage,
					useFactory: () => {
						throw new Error('IndexedDB unavailable');
					},
				},
				{ provide: Router, useValue: { navigate } },
				{
					provide: OwnerSessionStore,
					useValue: {
						ownerEmail: () => 'owner@example.test',
						expire,
						sessionKey,
						signOutLocally: vi.fn(),
					},
				},
			],
		});
		store = TestBed.inject(SignOutStore);
		store.signOut({ operation: 'sign-out' });
		await vi.waitFor(() => expect(gateway.signOut).toHaveBeenCalledOnce());
		gateway.succeed();
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(deactivate).not.toHaveBeenCalled();
	});
	it('requires confirmation before destroying pending work and lets the user keep working', async () => {
		deactivate.mockResolvedValueOnce({ kind: 'confirmation', count: 2 });
		store.signOut({ operation: 'sign-out' });
		await Promise.resolve();
		await Promise.resolve();
		await vi.waitFor(() =>
			expect(store.outcome()).toMatchObject({
				status: 'confirmation',
				count: 2,
			}),
		);
		expect(gateway.signOut).not.toHaveBeenCalled();
		expect(expire).not.toHaveBeenCalled();
		store.cancelSignOut();
		expect(store.outcome().status).toBe('idle');
		store.cancelSignOut();
		store.signOut({ operation: 'sign-out', discardPending: true });
		await Promise.resolve();
		await Promise.resolve();
		expect(deactivate).toHaveBeenLastCalledWith('session-1', true);
	});
	it('signs out locally offline, clears memory, and retries server revocation separately', async () => {
		const offline = TestBed.inject(OfflineWorkspaceStore);
		(
			offline.networkUnavailable as unknown as ReturnType<
				typeof signal<boolean>
			>
		).set(true);
		const connectivity = TestBed.inject(OfflineConnectivity);
		TestBed.tick();
		store.signOut({ operation: 'sign-out', discardPending: true });
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(gateway.signOut).not.toHaveBeenCalled();
		expect(offline.clear).toHaveBeenCalled();
		expect(TestBed.inject(OwnerSessionStore).signOutLocally).toHaveBeenCalled();
		expect(expire).not.toHaveBeenCalled();
		expect(navigate).toHaveBeenCalledWith(['/sign-in']);
		expect(store.pendingRemoteOperationId()).toBe('sign-out-1');
		connectivity.retryHint.update((value) => value + 1);
		TestBed.tick();
		expect(gateway.signOut).toHaveBeenCalledOnce();
		gateway.fail({ kind: 'unavailable' });
		expect(connectivity.scheduleRetry).toHaveBeenCalled();
		gateway.reset();
		store.retryRemoteSignOut();
		gateway.succeed();
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(completeSignOut).toHaveBeenCalledWith('sign-out-1');
		expect(store.pendingRemoteOperationId()).toBeNull();
	});
	it.each([
		{ kind: 'unavailable' as const },
		{ kind: 'http' as const, status: 504 },
	])(
		'finishes confirmed local sign-out when the request discovers an outage: %s',
		async (error) => {
			store.signOut({ operation: 'sign-out' });
			await Promise.resolve();
			await Promise.resolve();
			gateway.fail(error);
			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(store.outcome().status).toBe('succeeded');
			expect(
				TestBed.inject(OwnerSessionStore).signOutLocally,
			).toHaveBeenCalled();
			expect(navigate).toHaveBeenCalledWith(['/sign-in']);
			expect(completeSignOut).not.toHaveBeenCalled();
		},
	);
});
