import {
	DestroyRef,
	InjectionToken,
	inject,
	Service,
	signal,
} from '@angular/core';

export type OfflineConnectivityBrowser = Readonly<{
	online: boolean;
	addEventListener(type: 'online' | 'offline', listener: EventListener): void;
	removeEventListener(
		type: 'online' | 'offline',
		listener: EventListener,
	): void;
}>;

export const currentOfflineConnectivityBrowser =
	(): OfflineConnectivityBrowser => ({
		online: globalThis.navigator?.onLine ?? true,
		addEventListener: (type, listener) =>
			globalThis.addEventListener(type, listener),
		removeEventListener: (type, listener) =>
			globalThis.removeEventListener(type, listener),
	});

export const OFFLINE_CONNECTIVITY_BROWSER =
	new InjectionToken<OfflineConnectivityBrowser>(
		'OFFLINE_CONNECTIVITY_BROWSER',
		{ factory: currentOfflineConnectivityBrowser },
	);

@Service()
export class OfflineConnectivity {
	private readonly browser = inject(OFFLINE_CONNECTIVITY_BROWSER);
	readonly online = signal(this.browser.online);
	private readonly wentOnline = (): void => this.online.set(true);
	private readonly wentOffline = (): void => this.online.set(false);

	constructor() {
		this.browser.addEventListener('online', this.wentOnline);
		this.browser.addEventListener('offline', this.wentOffline);
		inject(DestroyRef).onDestroy(() => {
			this.browser.removeEventListener('online', this.wentOnline);
			this.browser.removeEventListener('offline', this.wentOffline);
		});
	}
}
