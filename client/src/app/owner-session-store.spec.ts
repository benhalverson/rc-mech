import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerSessionStore } from './owner-session-store';

describe('OwnerSessionStore', () => {
	let http: HttpTestingController;
	let store: OwnerSessionStore;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				OwnerSessionStore,
			],
		});
		http = TestBed.inject(HttpTestingController);
		store = TestBed.inject(OwnerSessionStore);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('exposes safe computed defaults for incomplete session data', () => {
		expect(store.hasResolvedSession).toBe(false);
		expect(store.resolutionFailed()).toBe(false);
		store.session.set({});
		expect(store.authenticated()).toBe(false);
		expect(store.ownerEmail()).toBe('Owner');
		store.session.set({ user: {} });
		expect(store.ownerEmail()).toBe('Owner');
	});

	it('distinguishes a failed session request from a signed-out response', async () => {
		const resolved = store.resolved();
		await vi.waitFor(() =>
			http
				.expectOne('/api/auth/get-session')
				.error(new ProgressEvent('offline')),
		);

		expect(await resolved).toBeNull();
		expect(store.resolutionFailed()).toBe(true);
		expect(store.authenticated()).toBe(false);
		expect(store.ownerEmail()).toBe('Owner');
	});

	it('resolves the current owner', async () => {
		const resolved = store.resolved();
		await vi.waitFor(() =>
			http.expectOne('/api/auth/get-session').flush({
				session: { id: 'session-1' },
				user: { email: 'owner@example.test' },
			}),
		);
		expect(await resolved).toEqual({
			session: { id: 'session-1' },
			user: { email: 'owner@example.test' },
		});
		expect(store.hasResolvedSession).toBe(true);
		expect(store.authenticated()).toBe(true);
		expect(store.ownerEmail()).toBe('owner@example.test');
	});

	it('reuses resolution when a resource reload cannot start', async () => {
		const resolved = store.resolved();
		await vi.waitFor(() => http.expectOne('/api/auth/get-session').flush(null));
		await resolved;
		vi.spyOn(store.session, 'reload').mockReturnValue(false);

		expect(await store.refresh()).toBeNull();
	});

	it('reloads and resolves the refreshed owner session', async () => {
		const initial = store.resolved();
		await vi.waitFor(() => http.expectOne('/api/auth/get-session').flush(null));
		await initial;

		const refreshed = store.refresh();
		await vi.waitFor(() =>
			http.expectOne('/api/auth/get-session').flush({
				session: { id: 'session-2' },
				user: { email: 'refreshed@example.test' },
			}),
		);

		expect(await refreshed).toEqual({
			session: { id: 'session-2' },
			user: { email: 'refreshed@example.test' },
		});
		expect(store.authenticated()).toBe(true);
	});

	it('expires local session state and starts a background refresh', () => {
		store.session.set({
			session: { id: 'session-1' },
			user: { email: 'owner@example.test' },
		});
		const refresh = vi.spyOn(store, 'refresh').mockResolvedValue(null);

		store.expire();

		expect(store.session.value()).toBeNull();
		expect(store.hasResolvedSession).toBe(true);
		expect(refresh).toHaveBeenCalledOnce();
	});
});
