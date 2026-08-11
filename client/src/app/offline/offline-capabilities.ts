import { InjectionToken, inject, Service } from '@angular/core';

export type OfflineBrowserCapabilities = Readonly<{
	serviceWorker?: Readonly<{ ready: Promise<unknown> }>;
	indexedDB?: unknown;
	caches?: unknown;
}>;

export type OfflineCapabilityResult = Readonly<{ supported: boolean }>;

export const offlineCapabilities = (
	browser: OfflineBrowserCapabilities,
): OfflineCapabilityResult => ({
	supported: Boolean(
		browser.serviceWorker && browser.indexedDB && browser.caches,
	),
});

export const currentOfflineBrowser = (): OfflineBrowserCapabilities => ({
	serviceWorker: globalThis.navigator?.serviceWorker,
	indexedDB: globalThis.indexedDB,
	caches: globalThis.caches,
});

export const OFFLINE_BROWSER = new InjectionToken<OfflineBrowserCapabilities>(
	'OFFLINE_BROWSER',
	{ factory: currentOfflineBrowser },
);

@Service()
export class OfflineCapabilities {
	private readonly browser = inject(OFFLINE_BROWSER);
	readonly supported = offlineCapabilities(this.browser).supported;
	readonly storageAvailable = Boolean(this.browser.indexedDB);

	async prepareShell(): Promise<boolean> {
		if (!this.supported) return false;
		await this.browser.serviceWorker?.ready;
		return true;
	}
}
