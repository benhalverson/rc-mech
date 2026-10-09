import { InjectionToken, inject, Service } from '@angular/core';
import { SwRegistrationOptions } from '@angular/service-worker';

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

/** Bound shell installation so an unavailable worker cannot block online work. */
export const offlineShellTimeout = (): number => 5_000;

export const OFFLINE_SHELL_TIMEOUT = new InjectionToken<number>(
	'OFFLINE_SHELL_TIMEOUT',
	{ factory: offlineShellTimeout },
);

@Service()
export class OfflineCapabilities {
	private readonly browser = inject(OFFLINE_BROWSER);
	private readonly registration = inject(SwRegistrationOptions, {
		optional: true,
	});
	private readonly shellTimeout = inject(OFFLINE_SHELL_TIMEOUT);
	readonly supported =
		this.registration?.enabled !== false &&
		offlineCapabilities(this.browser).supported;
	readonly storageAvailable = Boolean(this.browser.indexedDB);

	/** Await a registered shell, falling back through the caller on stalled setup. */
	async prepareShell(): Promise<boolean> {
		if (!this.supported) return false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.browser.serviceWorker?.ready,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() =>
							reject(new Error('Offline application shell is unavailable.')),
						this.shellTimeout,
					);
				}),
			]);
			return true;
		} finally {
			clearTimeout(timeout);
		}
	}
}
