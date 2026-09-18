import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TestBed } from '@angular/core/testing';
import { filter, firstValueFrom, map, type Observable, take } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerSessionStore } from '../owner-session-store';
import { VisibilityStore } from './visibility-store';

describe('VisibilityStore session snapshot', () => {
	const sessionKey = signal<string | null>('first');
	let store: InstanceType<typeof VisibilityStore>;
	let http: HttpTestingController;
	let resolution: Observable<unknown>;
	const resolved = () =>
		firstValueFrom(
			resolution.pipe(
				filter(() => !store.pending()),
				take(1),
				map(() => store.visible()),
			),
		);
	const requests = () => {
		TestBed.tick();
		return {
			owner: http.expectOne('/api/v1/feature-flags/owner'),
			flag: http.expectOne('/api/v1/feature-flags/driving-analysis'),
		};
	};
	beforeEach(() => {
		sessionKey.set('first');
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				{ provide: OwnerSessionStore, useValue: { sessionKey } },
			],
		});
		store = TestBed.inject(VisibilityStore);
		http = TestBed.inject(HttpTestingController);
		resolution = TestBed.runInInjectionContext(() =>
			toObservable(store.resolution),
		);
	});
	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});
	it('hides while pending, reads once and retains a successful snapshot', async () => {
		expect(store.visible()).toBe(false);
		expect(store.pending()).toBe(true);
		const read = requests();
		read.owner.flush({ isOwner: false });
		TestBed.tick();
		expect(store.visible()).toBe(false);
		read.flag.flush({ enabled: true });
		TestBed.tick();
		expect(await resolved()).toBe(true);
		window.dispatchEvent(new Event('focus'));
		window.dispatchEvent(new Event('offline'));
		TestBed.tick();
		expect(store.visible()).toBe(true);
		http.expectNone('/api/v1/feature-flags/driving-analysis');
	});
	it('retains independently verified Owner access after flag failure', async () => {
		const read = requests();
		read.owner.flush({ isOwner: true });
		TestBed.tick();
		await vi.waitFor(() => expect(store.isOwner()).toBe(true));
		expect(await resolved()).toBe(true);
		read.flag.flush('Unavailable', { status: 503, statusText: 'Unavailable' });
		TestBed.tick();
		expect(store.visible()).toBe(true);
	});
	it.each([{}, { enabled: 'true' }, { enabled: false }])(
		'fails closed for missing, malformed or disabled flags: %j',
		async (response) => {
			const read = requests();
			read.owner.flush({ isOwner: false });
			read.flag.flush(response);
			TestBed.tick();
			expect(await resolved()).toBe(false);
		},
	);
	it('unknown identity does not grant an exemption', async () => {
		const read = requests();
		read.owner.flush({});
		read.flag.error(new ProgressEvent('timeout'));
		TestBed.tick();
		expect(await resolved()).toBe(false);
		expect(store.isOwner()).toBe(false);
	});
	it('immediately fences old ownership and cancels old reads on identity replacement', async () => {
		const old = requests();
		old.owner.flush({ isOwner: true });
		TestBed.tick();
		sessionKey.set('second');
		expect(store.isOwner()).toBe(false);
		expect(store.visible()).toBe(false);
		expect(store.pending()).toBe(true);
		const next = requests();
		expect(old.flag.cancelled).toBe(true);
		next.owner.flush({ isOwner: false });
		next.flag.flush({ enabled: false });
		TestBed.tick();
		expect(await resolved()).toBe(false);
		sessionKey.set(null);
		expect(store.visible()).toBe(false);
		TestBed.tick();
		expect(await resolved()).toBe(false);
		sessionKey.set('third');
		const fresh = requests();
		fresh.owner.flush({ isOwner: false });
		fresh.flag.flush({ enabled: true });
		TestBed.tick();
		expect(await resolved()).toBe(true);
	});
	it('uses bounded uncached network reads with service worker bypass', () => {
		const read = requests();
		for (const request of [read.owner, read.flag]) {
			expect(request.request.withCredentials).toBe(true);
			expect(request.request.timeout).toBe(5000);
			expect(request.request.cache).toBe('no-store');
			expect(request.request.headers.get('ngsw-bypass')).toBe('true');
			request.error(new ProgressEvent('error'));
		}
		TestBed.tick();
		expect(store.visible()).toBe(false);
	});

	it('does not replay a settled result while a replacement session is pending', async () => {
		const first = requests();
		first.owner.flush({ isOwner: true });
		first.flag.flush({ enabled: false });
		expect(await resolved()).toBe(true);
		sessionKey.set('replacement');
		const completed = vi.fn();
		const resolution = resolved().then(completed);
		await Promise.resolve();
		expect(completed).not.toHaveBeenCalled();
		const next = requests();
		next.owner.flush({ isOwner: false });
		next.flag.flush({ enabled: true });
		await resolution;
		expect(completed).toHaveBeenCalledWith(true);
	});

	it('clears both pending reads on sign-out and does not retain late ownership', async () => {
		const first = requests();
		sessionKey.set(null);
		TestBed.tick();
		expect(first.owner.cancelled).toBe(true);
		expect(first.flag.cancelled).toBe(true);
		expect(await resolved()).toBe(false);
		expect(store.isOwner()).toBe(false);
		http.expectNone('/api/v1/feature-flags/owner');
	});
});
