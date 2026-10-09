import { TestBed } from '@angular/core/testing';
import { SwRegistrationOptions } from '@angular/service-worker';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	currentOfflineBrowser,
	OFFLINE_BROWSER,
	OFFLINE_SHELL_TIMEOUT,
	OfflineCapabilities,
	offlineCapabilities,
	offlineShellTimeout,
} from './offline-capabilities';

describe('offlineCapabilities', () => {
	afterEach(() => {
		vi.useRealTimers();
		TestBed.resetTestingModule();
	});

	it('requires Service Worker, IndexedDB, and Cache Storage together', () => {
		const supported = {
			serviceWorker: { ready: Promise.resolve() },
			indexedDB: {},
			caches: {},
		};

		expect(offlineCapabilities(supported)).toEqual({ supported: true });
		expect(
			offlineCapabilities({ ...supported, serviceWorker: undefined }),
		).toEqual({ supported: false });
		expect(offlineCapabilities({ ...supported, indexedDB: undefined })).toEqual(
			{
				supported: false,
			},
		);
		expect(offlineCapabilities({ ...supported, caches: undefined })).toEqual({
			supported: false,
		});
	});

	it('keeps development mode online-only when worker registration is disabled', async () => {
		TestBed.configureTestingModule({
			providers: [
				OfflineCapabilities,
				{ provide: SwRegistrationOptions, useValue: { enabled: false } },
				{
					provide: OFFLINE_BROWSER,
					useValue: {
						serviceWorker: { ready: new Promise(() => {}) },
						indexedDB: {},
						caches: {},
					},
				},
			],
		});
		const capabilities = TestBed.inject(OfflineCapabilities);
		expect(capabilities.supported).toBe(false);
		expect(capabilities.storageAvailable).toBe(true);
		await expect(capabilities.prepareShell()).resolves.toBe(false);
	});

	it('bounds a stalled worker and permits a later preparation retry', async () => {
		vi.useFakeTimers();
		let finish!: () => void;
		const ready = new Promise<void>((resolve) => {
			finish = resolve;
		});
		TestBed.configureTestingModule({
			providers: [
				OfflineCapabilities,
				{ provide: SwRegistrationOptions, useValue: { enabled: true } },
				{ provide: OFFLINE_SHELL_TIMEOUT, useValue: 100 },
				{
					provide: OFFLINE_BROWSER,
					useValue: { serviceWorker: { ready }, indexedDB: {}, caches: {} },
				},
			],
		});
		const capabilities = TestBed.inject(OfflineCapabilities);
		const preparation = expect(capabilities.prepareShell()).rejects.toThrow(
			'Offline application shell is unavailable',
		);
		await vi.advanceTimersByTimeAsync(100);
		await preparation;
		expect(vi.getTimerCount()).toBe(0);
		finish();
		await expect(capabilities.prepareShell()).resolves.toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		expect(offlineShellTimeout()).toBe(5_000);
	});

	it('waits for the installed application shell only in supported browsers', async () => {
		const ready = Promise.resolve({ active: true });
		TestBed.configureTestingModule({
			providers: [
				OfflineCapabilities,
				{
					provide: OFFLINE_BROWSER,
					useValue: { serviceWorker: { ready }, indexedDB: {}, caches: {} },
				},
			],
		});
		const supported = TestBed.inject(OfflineCapabilities);
		expect(supported.supported).toBe(true);
		expect(supported.storageAvailable).toBe(true);
		await expect(supported.prepareShell()).resolves.toBe(true);

		TestBed.resetTestingModule();
		TestBed.configureTestingModule({
			providers: [
				OfflineCapabilities,
				{ provide: OFFLINE_BROWSER, useValue: {} },
			],
		});
		const unsupported = TestBed.inject(OfflineCapabilities);
		expect(unsupported.supported).toBe(false);
		expect(unsupported.storageAvailable).toBe(false);
		await expect(unsupported.prepareShell()).resolves.toBe(false);
		expect(currentOfflineBrowser()).toHaveProperty('indexedDB');
	});
});
