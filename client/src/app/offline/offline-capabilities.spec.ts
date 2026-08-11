import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
	currentOfflineBrowser,
	OFFLINE_BROWSER,
	OfflineCapabilities,
	offlineCapabilities,
} from './offline-capabilities';

describe('offlineCapabilities', () => {
	afterEach(() => TestBed.resetTestingModule());

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
