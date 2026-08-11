import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	currentOfflineConnectivityBrowser,
	OFFLINE_CONNECTIVITY_BROWSER,
	OfflineConnectivity,
	type OfflineConnectivityBrowser,
} from './offline-connectivity';

class FakeBrowser implements OfflineConnectivityBrowser {
	readonly listeners = new Map<string, EventListener>();
	readonly addEventListener = vi.fn(
		(type: 'online' | 'offline', listener: EventListener) =>
			this.listeners.set(type, listener),
	);
	readonly removeEventListener = vi.fn(
		(type: 'online' | 'offline', listener: EventListener) => {
			if (this.listeners.get(type) === listener) this.listeners.delete(type);
		},
	);

	constructor(readonly online: boolean) {}

	emit(type: 'online' | 'offline'): void {
		this.listeners.get(type)?.(new Event(type));
	}
}

describe('OfflineConnectivity', () => {
	afterEach(() => {
		TestBed.resetTestingModule();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('treats browser connectivity as a retry hint and removes its listeners', () => {
		const browser = new FakeBrowser(true);
		TestBed.configureTestingModule({
			providers: [
				OfflineConnectivity,
				{ provide: OFFLINE_CONNECTIVITY_BROWSER, useValue: browser },
			],
		});
		const connectivity = TestBed.inject(OfflineConnectivity);
		expect(connectivity.retryHint()).toBe(0);

		browser.emit('offline');
		expect(connectivity.retryHint()).toBe(0);
		browser.emit('online');
		expect(connectivity.retryHint()).toBe(1);

		TestBed.resetTestingModule();
		expect(browser.removeEventListener).toHaveBeenCalledTimes(2);
		expect(browser.listeners.size).toBe(0);

		const current = currentOfflineConnectivityBrowser();
		expect(current.online).toBeTypeOf('boolean');
		const listener = vi.fn();
		current.addEventListener('offline', listener);
		globalThis.dispatchEvent(new Event('offline'));
		expect(listener).toHaveBeenCalledOnce();
		current.removeEventListener('offline', listener);

		vi.stubGlobal('navigator', undefined);
		expect(currentOfflineConnectivityBrowser().online).toBe(true);
	});

	it('retries from request outcomes with bounded backoff and resets after success', () => {
		vi.useFakeTimers();
		const browser = new FakeBrowser(true);
		TestBed.configureTestingModule({
			providers: [
				OfflineConnectivity,
				{ provide: OFFLINE_CONNECTIVITY_BROWSER, useValue: browser },
			],
		});
		const connectivity = TestBed.inject(OfflineConnectivity);

		connectivity.scheduleRetry();
		connectivity.scheduleRetry();
		vi.advanceTimersByTime(499);
		expect(connectivity.retryHint()).toBe(0);
		vi.advanceTimersByTime(1);
		expect(connectivity.retryHint()).toBe(1);

		connectivity.scheduleRetry();
		connectivity.markRequestSucceeded();
		vi.advanceTimersByTime(1_000);
		expect(connectivity.retryHint()).toBe(2);

		connectivity.markRequestSucceeded();
		connectivity.scheduleRetry();
		browser.emit('online');
		expect(connectivity.retryHint()).toBe(3);
		vi.advanceTimersByTime(500);
		expect(connectivity.retryHint()).toBe(3);
	});
});
